package app.urbudget

import java.io.IOException
import java.security.KeyStoreException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SecretStoreTest {
  @get:Rule
  val temporary = TemporaryFolder()

  private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  private fun seal(key: SecretKey, name: String, plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(name.toByteArray())
    return cipher.iv + cipher.doFinal(plain)
  }

  @Test
  fun onlyAnAbsentFileReturnsNull() {
    val absent = temporary.root.resolve("absent")
    assertNull(SecretStore.readSecret(absent, "synthetic") { error("An absent file needs no key") })
    // A directory is present but cannot be read as a secret. It must not look absent.
    val directory = temporary.newFolder("unreadable")
    assertThrows(IOException::class.java) {
      SecretStore.readSecret(directory, "synthetic") { error("I/O failed before key access") }
    }
  }

  @Test
  fun missingOrTemporarilyUnavailableKeysThrowWithoutChangingTheFile() {
    val key = newKey()
    val sealed = seal(key, "synthetic", "keep-me".toByteArray())
    val file = temporary.newFile("sealed").apply { writeBytes(sealed) }
    assertThrows(KeyStoreException::class.java) {
      SecretStore.readSecret(file, "synthetic") { null }
    }
    assertThrows(KeyStoreException::class.java) {
      SecretStore.readSecret(file, "synthetic") { throw KeyStoreException("Synthetic temporary failure") }
    }
    assertArrayEquals(sealed, file.readBytes())
    assertArrayEquals("keep-me".toByteArray(), SecretStore.readSecret(file, "synthetic") { key })
  }

  @Test
  fun damagedCiphertextAndWrongKeysThrowAndLeaveTheBytesRecoverable() {
    val key = newKey()
    val sealed = seal(key, "synthetic", "keep-me".toByteArray())
    val file = temporary.newFile("sealed")
    for (damaged in listOf(byteArrayOf(), sealed.copyOf(5), sealed.clone().apply {
      this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte()
    })) {
      file.writeBytes(damaged)
      assertThrows(Exception::class.java) { SecretStore.readSecret(file, "synthetic") { key } }
      assertArrayEquals(damaged, file.readBytes())
    }
    file.writeBytes(sealed)
    assertThrows(Exception::class.java) { SecretStore.readSecret(file, "synthetic") { newKey() } }
    assertThrows(Exception::class.java) { SecretStore.readSecret(file, "different-service") { key } }
    assertArrayEquals(sealed, file.readBytes())
    assertArrayEquals("keep-me".toByteArray(), SecretStore.readSecret(file, "synthetic") { key })
  }
}
