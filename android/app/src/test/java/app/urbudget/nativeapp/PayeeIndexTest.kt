package app.urbudget.nativeapp

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PayeeIndexTest {
    private val budget = JSONObject("""{
      "accounts":[{"id":"cash","kind":"cash"},{"id":"save","kind":"cash"},{"id":"house","kind":"tracking"}],
      "categories":[{"id":"food","name":"Food"},{"id":"fun","name":"Fun"},{"id":"unc","name":"Uncategorized"}],
      "payees":[{"id":"saved-shop","name":"Shop","categoryId":"fun","note":"kept"},{"id":"t","name":"Transfer : Savings"},
                {"id":"gone","name":"Old","categoryId":"deleted-category"},{"id":"fresh","name":"Fresh"}],
      "schedules":[{"transaction":{"payee":"Landlord"}}],
      "payeeRules":[{"id":"r1","match":"AMZN","payee":"Amazon","categoryId":null},{"id":"r2","match":"amzn mktp","payee":"Amazon Marketplace","categoryId":"fun"},
                    {"id":"r3","match":"CARREFOUR","payee":"","categoryId":"food"}],
      "transactions":[
        {"id":"1","date":"2026-10-01","accountId":"cash","payee":"Shop","amount":-500,"splits":[{"categoryId":"food","amount":-500}]},
        {"id":"2","date":"2026-10-09","accountId":"cash","payee":"Shop ","amount":-700,"splits":[{"categoryId":"fun","amount":-400},{"categoryId":"food","amount":-300}]},
        {"id":"3","date":"2026-10-05","accountId":"cash","payee":"Cafe","amount":-300,"splits":[{"categoryId":"food","amount":-300}]},
        {"id":"4","date":"2026-10-06","accountId":"cash","payee":"Shop","amount":-100,"transferAccountId":"save","splits":[{"amount":-100}]},
        {"id":"5","date":"2026-10-07","accountId":"cash","payee":"Cafe","amount":-200,"splits":[{"categoryId":null,"amount":-200,"payee":"Split only"}]},
        {"id":"6","date":"2026-10-10","accountId":"cash","payee":"Bank text","importedPayee":"POS AMZN MKTP 123","amount":-900,"splits":[{"categoryId":null,"amount":-900}]},
        {"id":"7","date":"2026-10-11","accountId":"cash","payee":"Carrefour city","amount":-400,"splits":[{"categoryId":"unc","amount":-400}]},
        {"id":"8","date":"2026-10-12","accountId":"house","payee":"Carrefour city","amount":-400,"splits":[{"categoryId":null,"amount":-400}]},
        {"id":"9","date":"2026-10-13","accountId":"cash","payee":"Amazon","amount":-100,"splits":[{"categoryId":"food","amount":-100}]}
      ]}""")

    @Test fun payeesAreCountedAndSortedWithDefaultsAndLastUsedCategories() = runTest {
        val index = payeeIndex(budget)
        val byName = index.associateBy { it.name }
        // Most used first, ties by name.
        assertEquals(listOf("Cafe", "Carrefour city", "Shop"), index.take(3).map { it.name })
        val shop = byName.getValue("Shop")
        // Trimmed names are one payee; a transfer with a payee name isn't a use of it.
        assertEquals(2, shop.count)
        assertEquals("2026-10-09", shop.last)
        assertEquals("fun", shop.default)
        assertEquals("A split use says nothing about a category, so the one before stands", "food", shop.lastUsed)
        assertEquals("saved-shop", shop.record.getString("id"))
        val cafe = byName.getValue("Cafe")
        assertEquals("", cafe.lastUsed)
        assertNull(cafe.default)
        assertNull("A default whose category is gone is skipped", byName.getValue("Old").default)
        assertFalse("YNAB's transfer payees are offered as transfers instead", byName.containsKey("Transfer : Savings"))
        assertEquals(0, byName.getValue("Fresh").count)
        // Names only used in schedules, split lines or rules come after the used ones.
        assertTrue(listOf("Landlord", "Split only", "Amazon Marketplace").all { it in byName })
        assertEquals(0, byName.getValue("Landlord").count)
        assertEquals(index.map { it.record.getString("id") }, payeeIndex(budget).map { it.record.getString("id") })
    }

    @Test fun payeeDetailListsTheLatestSixAndTheTotal() = runTest {
        val many = JSONObject(budget.toString())
        repeat(8) { many.getJSONArray("transactions").put(JSONObject().put("id", "x$it").put("date", "2026-09-0${it + 1}").put("accountId", "cash")
            .put("payee", "Cafe").put("amount", -10).put("splits", org.json.JSONArray().put(JSONObject().put("categoryId", "food").put("amount", -10)))) }
        val detail = payeeDetail(many, "Cafe")
        assertEquals(10, detail.count)
        assertEquals(-580, detail.total)
        assertEquals(listOf("5", "3", "x7", "x6", "x5", "x4"), detail.recent.map { it.id })
        assertEquals("food", detail.recent[1].categoryId)
    }

    @Test fun ruleChangesMirrorTheEngineRules() = runTest {
        assertEquals("pos amzn mktp 123", PayeeRules.normalize("POS*AMZN  MKTP-123"))
        val rules = budget.getJSONArray("payeeRules").let { a -> (0 until a.length()).map(a::getJSONObject) }
        // 6: the longer "amzn mktp" wins and renames it (and fills its empty category); 7: Carrefour gets Food
        // in place of the placeholder; 8 is a tracking account, renamed by no rule; 9 is already Amazon.
        assertEquals(2, PayeeRules.changes(budget, rules))
        assertEquals(1, PayeeRules.changes(budget, rules, setOf("r2")))
        assertEquals(0, PayeeRules.changes(budget, rules, setOf("r1")))
        assertEquals(1, PayeeRules.changes(budget, rules, setOf("r3")))
        assertEquals(0, PayeeRules.changes(budget, emptyList()))
    }
}
