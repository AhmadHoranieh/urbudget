package app.urbudget.nativeapp

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RegisterDisplayTest {
    @Test fun incomingTransferHasSamePositiveAmountForPresentationFilteringAndSorting() {
        val transfer = JSONObject("""{"accountId":"cash","transferAccountId":"savings","amount":-10000}""")
        assertEquals(-10000L, registerAmount(transfer, "cash"))
        assertEquals(-10000L, registerAmount(transfer, ""))
        assertEquals(10000L, registerAmount(transfer, "savings"))
        val deposit = JSONObject("""{"accountId":"savings","amount":5000}""")
        assertEquals(listOf(deposit, transfer), listOf(transfer, deposit).sortedBy { registerAmount(it, "savings") })
        assertEquals(listOf(transfer), listOf(transfer, deposit).filter { registerAmount(it, "savings") >= 7500 })
    }

    @Test fun receivingAccountSumsItsSplitLegsWithoutUnrelatedExpenseOrTransferParts() {
        val split = JSONObject("""{"accountId":"cash","amount":-25000,"splits":[
            {"amount":-10000,"transferAccountId":"savings"},
            {"amount":-4000,"transferAccountId":"savings"},
            {"amount":1000,"transferAccountId":"savings"},
            {"amount":-5000,"transferAccountId":"card"},
            {"amount":-7000,"categoryId":"food"}]}""")
        assertEquals(-25000L, registerAmount(split, "cash"))
        assertEquals(13000L, registerAmount(split, "savings"))
        assertEquals(5000L, registerAmount(split, "card"))
    }
}
