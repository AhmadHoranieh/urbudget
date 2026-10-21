//! Android's credential store: `app.urbudget.SecretStore` in shared/android, which seals each secret
//! under a key kept in the Android Keystore. It's called over JNI from whichever thread asks, so
//! it needs neither the window nor Android's main thread, and works before either exists.
use jni::objects::{GlobalRef, JByteArray, JClass, JObject, JValue};
use jni::{JNIEnv, JavaVM};
use std::sync::OnceLock;

static NATIVE_CONTEXT: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

/// Native Compose provides its application context once; it remains a global JNI reference for
/// worker threads. Tauri hosts can continue using ndk-context below.
pub fn init(env: &mut JNIEnv<'_>, context: &JObject<'_>) -> Result<(), String> {
    let vm = env.get_java_vm().map_err(|e| e.to_string())?;
    let context = env.new_global_ref(context).map_err(|e| e.to_string())?;
    let _ = NATIVE_CONTEXT.set((vm, context));
    Ok(())
}

/// Runs `f` with the SecretStore class and the application context.
fn call<T>(f: impl FnOnce(&mut JNIEnv, &JClass, &JObject) -> jni::errors::Result<T>) -> Result<T, ()> {
    if let Some((vm, context)) = NATIVE_CONTEXT.get() {
        return with_context(vm, context.as_obj(), f);
    }
    let android = ndk_context::android_context();
    // SAFETY: tao fills ndk_context before the app's code runs, with the process's JavaVM and a
    // global reference to the application context, and releases neither while the app runs.
    let vm = unsafe { JavaVM::from_raw(android.vm().cast()) }.map_err(|_| ())?;
    let context = unsafe { JObject::from_raw(android.context().cast()) };
    with_context(&vm, &context, f)
}

fn with_context<T>(vm: &JavaVM, context: &JObject, f: impl FnOnce(&mut JNIEnv, &JClass, &JObject) -> jni::errors::Result<T>) -> Result<T, ()> {
    let mut env = vm.attach_current_thread().map_err(|_| ())?;
    // The frame frees this call's local references, even on a thread that stays attached.
    let result = env.with_local_frame(8, |env| {
        // On a thread Rust started, looking a class up by name finds only Android's own, so the
        // app's class comes from its class loader.
        let loader = env.call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
        let name = env.new_string("app.urbudget.SecretStore")?;
        let class = env
            .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])?
            .l()?;
        f(env, &JClass::from(class), &context)
    });
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
    }
    result.map_err(|_| ())
}

/// Only a confirmed absent secret is `Ok(None)`; Java/JNI/key access failures remain errors.
pub fn read(service: &str) -> Result<Option<Vec<u8>>, ()> {
    call(|env, class, context| {
        let name = env.new_string(service)?;
        let found = env
            .call_static_method(
                class,
                "read",
                "(Landroid/content/Context;Ljava/lang/String;)[B",
                &[JValue::Object(context), JValue::Object(&name)],
            )?
            .l()?;
        if found.is_null() {
            return Ok(None);
        }
        env.convert_byte_array(JByteArray::from(found)).map(Some)
    })
}
pub fn save(service: &str, _account: &str, secret: &[u8]) -> Result<(), ()> {
    let saved = call(|env, class, context| {
        let (name, secret) = (env.new_string(service)?, env.byte_array_from_slice(secret)?);
        env.call_static_method(
            class,
            "save",
            "(Landroid/content/Context;Ljava/lang/String;[B)Z",
            &[JValue::Object(context), JValue::Object(&name), JValue::Object(&secret)],
        )?
        .z()
    })?;
    saved.then_some(()).ok_or(())
}
pub fn delete(service: &str, _account: &str) -> Result<(), ()> {
    let deleted = call(|env, class, context| {
        let name = env.new_string(service)?;
        env.call_static_method(
            class,
            "delete",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[JValue::Object(context), JValue::Object(&name)],
        )?
        .z()
    })?;
    deleted.then_some(()).ok_or(())
}
