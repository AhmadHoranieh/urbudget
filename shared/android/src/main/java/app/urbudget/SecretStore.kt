package app.urbudget

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.security.KeyStore
import java.security.KeyStoreException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The secrets the app keeps between launches (API keys, sign-ins, the sync key), for Rust
 * (crates/urbudget-services/src/keystore.rs, over JNI). Each is sealed with AES-GCM under one key that never
 * leaves the Android Keystore, and saved under no_backup/secrets. Backups and device transfers
 * skip that folder: the key stays on this phone, so a copy elsewhere couldn't be opened.
 *
 * Android deletes the key and the folder when the app is uninstalled or its storage is cleared.
 */
object SecretStore {
  private const val KEY = "urbudget.secrets"
  private const val CIPHER = "AES/GCM/NoPadding"
  /** The Keystore picks each nonce; for GCM it is 12 bytes, saved before the sealed secret. */
  private const val NONCE = 12

  @JvmStatic
  @Synchronized
  fun read(context: Context, name: String): ByteArray? =
    readSecret(file(context, name), name) { key(create = false) }

  /** Null means only an absent file. Errors reach Rust through JNI, preventing vault reset. */
  internal fun readSecret(file: File, name: String, loadKey: () -> SecretKey?): ByteArray? {
    val sealed = try {
      Files.readAllBytes(file.toPath())
    } catch (e: NoSuchFileException) {
      return null
    }
    val key = loadKey() ?: throw KeyStoreException("The stored secret's key is unavailable.")
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, NONCE))
    // The name is authenticated too, so one secret's file can't stand in for another's.
    cipher.updateAAD(name.toByteArray())
    return cipher.doFinal(sealed, NONCE, sealed.size - NONCE)
  }

  @JvmStatic
  @Synchronized
  fun save(context: Context, name: String, secret: ByteArray): Boolean {
    return try {
      val cipher = Cipher.getInstance(CIPHER)
      cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
      cipher.updateAAD(name.toByteArray())
      val sealed = cipher.doFinal(secret)
      if (cipher.iv.size != NONCE) return false
      val file = file(context, name)
      file.parentFile?.mkdirs()
      // Written beside it, then renamed over it, so a phone that dies mid-write keeps the old one.
      val temporary = File(file.path + ".tmp")
      temporary.outputStream().use { output ->
        output.write(cipher.iv + sealed)
        output.fd.sync()
      }
      temporary.renameTo(file)
    } catch (e: Exception) {
      false
    }
  }

  /** False when there was nothing to remove. */
  @JvmStatic
  @Synchronized
  fun delete(context: Context, name: String): Boolean = file(context, name).delete()

  private fun file(context: Context, name: String) =
    File(File(context.noBackupFilesDir, "secrets"), name.replace(Regex("[^A-Za-z0-9._-]"), "_"))

  private fun key(create: Boolean): SecretKey? {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY, null) as SecretKey?)?.let { return it }
    if (!create) return null
    // Only this app can use the key. It doesn't ask for the screen lock, so the app reads its
    // secrets without asking, as it does on a computer.
    val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      .apply { init(spec) }
      .generateKey()
  }
}
