package app.urbudget

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayPurchaseRoutingTest {
    @Test
    fun anotherProductsReceiptDoesNotFinishTheActiveSyncCheckout() {
        assertFalse(matchesActivePurchase(listOf("another_product"), "account-a", "urbudget_sync", "account-a"))
        assertTrue(matchesActivePurchase(listOf("urbudget_sync"), "account-a", "urbudget_sync", "account-a"))
    }

    @Test
    fun anotherAccountsReceiptDoesNotFinishTheActiveCheckout() {
        assertFalse(matchesActivePurchase(listOf("urbudget_sync"), "account-b", "urbudget_sync", "account-a"))
        assertFalse(matchesActivePurchase(listOf("urbudget_sync"), null, "urbudget_sync", "account-a"))
    }

    @Test
    fun receiptMustContainTheRequestedProduct() {
        assertFalse(matchesActivePurchase(emptyList(), "account-a", "urbudget_sync", "account-a"))
    }
}
