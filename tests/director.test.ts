// Stage 2: the Kairos Director (deterministic collections pacing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRECTOR_PARAMS as P, customerHistory, direct, nextWeekday, weekdayOf, type DirectorInput } from "../lib/director/model";
import { OFFERS_OFF, planFor, type DraftPlan } from "../lib/agent/policy";
import type { InvoiceRecord } from "../lib/agent/sweep";
import { POLICY_ON, TODAY, demoInput, inv } from "./director-fixture";
import { CUSTOMERS, DEMO_POLICY, issueDate, paymentDate } from "../lib/demo/reset";
import { addDays } from "../lib/clock";

const moveOf = (input: DirectorInput, id: string) => direct(input).moves.find((m) => m.invoiceId === id)!;

test("pressure math: every point comes from a named factor, by the documented formula", () => {
  const input: DirectorInput = { today: TODAY, sends: [], received: [], paymentPlan: OFFERS_OFF, cashTarget14d: 0, invoices: [inv("A", "a@x", "SENT", 100000, 30)] };
  const m = moveOf(input, "A");
  // base 20 + age 25×30/60 + money 20×1000/2500 + share 10×100% = 50.5 → 51
  const expected = P.base + P.agePts * 30 / P.ageFullDays + P.moneyPts * 1000 / P.moneyFull + P.sharePts * 1;
  assert.equal(expected, 50.5);
  assert.equal(m.pressure, 51);
  assert.deepEqual(m.factors.map((f) => [f.key, f.points]), [["base", 20], ["age", 12.5], ["money", 8], ["share", 10]]);
  assert.equal(m.move, "firm");
  assert.equal(m.day, TODAY);
  assert.match(m.reason, /^Firm reminder: pressure 51; 30 days overdue; 100% of everything you're owed; \$1,000\.00 due\. Today\.$/);
});

test("the demo personas: reliable → wait, silent high-value → offer payment plan, recent partial payment → pause, new → friendly, 75 days → escalate", () => {
  const plan = direct(demoInput());
  const by = Object.fromEntries(plan.moves.map((m) => [m.invoiceId, m]));
  assert.equal(by["D-1043"].move, "wait");
  assert.match(by["D-1043"].reason, /pays on time 100% of the time/);
  assert.equal(by["M-1046"].move, "payment_plan");
  assert.match(by["M-1046"].reason, /usually pays 43\.5 days late/);
  assert.equal(by["T-1045"].move, "wait");
  assert.equal(by["T-1045"].rule, "relief");
  assert.match(by["T-1045"].reason, /^Pause: the customer part paid \$200\.00 on 2026-11-08/);
  assert.equal(by["P-1044"].move, "friendly");
  assert.equal(by["P-1047"].move, "escalate");
  assert.equal(by["T-1048"].move, "friendly");
  // Customer rows: highest pressure first; each customer's top invoice decides the row.
  assert.deepEqual(plan.customers.map((c) => [c.customer, c.move]), [["maya@x", "payment_plan"], ["priya@x", "escalate"], ["tom@x", "friendly"], ["daniel@x", "wait"]]);
});

test("relief: a partial payment on the invoice, or a PayPal payment from the customer, drops pressure and pauses", () => {
  const before = moveOf(demoInput({ invoices: demoInput().invoices.map((i) => i.invoiceId === "M-1046" ? { ...i } : i) }), "M-1046");
  const withPartial = demoInput({ invoices: demoInput().invoices.map((i) => i.invoiceId === "M-1046" ? { ...i, status: "PARTIALLY_PAID", payments: [{ date: "2026-11-09", cents: 50000, method: "PAYPAL" }], dueCents: 185000 } : i) });
  const after = moveOf(withPartial, "M-1046");
  assert.equal(after.move, "wait");
  assert.equal(after.rule, "relief");
  assert.ok(after.pressure < before.pressure * 0.5, `${after.pressure} vs ${before.pressure}`);
  // Transaction Search payment from the same customer (any invoice) within 7 days also counts.
  const viaPayPal = moveOf(demoInput({ received: [{ payerEmail: "maya@x", date: "2026-11-06", cents: 10000, invoiceRef: null }] }), "M-1046");
  assert.equal(viaPayPal.move, "wait");
  assert.match(viaPayPal.reason, /sent a PayPal payment of \$100\.00 on 2026-11-06/);
  // …but not one older than the relief window.
  assert.equal(moveOf(demoInput({ received: [{ payerEmail: "maya@x", date: "2026-10-30", cents: 10000, invoiceRef: null }] }), "M-1046").move, "payment_plan");
});

test("cooldown always wins: a recent reminder pushes the day out 7 days whatever the pressure", () => {
  const base = demoInput();
  for (const sentDaysAgo of [0, 3, 6]) {
    const sentOn = `2026-11-${String(10 - sentDaysAgo).padStart(2, "0")}`;
    const m = moveOf({ ...base, cashTarget14d: 100000, sends: [{ invoiceId: "M-1046", date: sentOn, offer: false }, { invoiceId: "M-1046", date: "2026-10-20", offer: false }] }, "M-1046");
    assert.ok(m.pressure >= P.urgentFrom, "urgent pressure");
    assert.equal(m.rule, "cooldown");
    const earliest = new Date(`${sentOn}T00:00:00Z`);
    earliest.setUTCDate(earliest.getUTCDate() + 7);
    assert.equal(m.day, earliest.toISOString().slice(0, 10), `sent ${sentOn}`);
    assert.ok(m.day! > TODAY);
  }
  // Exactly 7 days later it's allowed again.
  assert.equal(moveOf({ ...base, sends: [{ invoiceId: "M-1046", date: "2026-11-03", offer: false }] }, "M-1046").day, TODAY);
});

test("hard rules: grace period waits, over 60 days escalates, flagged text and a policy that's off never get a payment plan", () => {
  const grace = moveOf({ ...demoInput(), invoices: [inv("G", "g@x", "SENT", 900000, 2)] }, "G");
  assert.deepEqual([grace.move, grace.rule], ["wait", "grace"]);
  const old = moveOf({ ...demoInput(), cashTarget14d: 0, invoices: [inv("O", "o@x", "SENT", 10000, 61)] }, "O");
  assert.deepEqual([old.move, old.rule], ["escalate", "escalation"]);
  const flagged = moveOf(demoInput({ invoices: demoInput().invoices.map((i) => i.invoiceId === "M-1046" ? { ...i, flagged: true } : i) }), "M-1046");
  assert.equal(flagged.move, "firm");
  assert.match(flagged.reason, /No offer: the invoice text is flagged/);
  assert.equal(moveOf(demoInput({ paymentPlan: OFFERS_OFF }), "M-1046").move, "firm");
  // A plan already offered and still unpaid: no second offer.
  const offered = moveOf(demoInput({ sends: [{ invoiceId: "M-1046", date: "2026-10-01", offer: true }] }), "M-1046");
  assert.notEqual(offered.move, "payment_plan");
  assert.match(offered.reason, /already offered/);
});

test("cash shortfall: the largest likely payers get more pressure, and the reason says so; no target, no effect", () => {
  const without = direct(demoInput());
  const withTarget = direct(demoInput({ cashTarget14d: 3000 }));
  assert.equal(without.forecast.shortfallCents, 0);
  assert.equal(withTarget.forecast.shortfallCents, 300000 - withTarget.forecast.expectedCents);
  const boosted = withTarget.moves.filter((m) => m.factors.some((f) => f.key === "cash"));
  assert.ok(boosted.length > 0 && boosted.length <= P.cashTopN);
  for (const m of boosted) {
    const w = without.moves.find((x) => x.invoiceId === m.invoiceId)!;
    assert.ok(m.factors.find((f) => f.key === "cash")!.points > 0);
    assert.ok(m.pressure >= w.pressure, m.invoiceId);
  }
  assert.ok(boosted.some((m) => m.invoiceId === "M-1046"), "the largest open balance");
  assert.ok(without.moves.every((m) => !m.factors.some((f) => f.key === "cash")));
});

test("history: average lateness, on-time ratio, lifetime paid, usual weekday (needs two), reminder response", () => {
  const input = demoInput({ sends: [{ invoiceId: "D-H3", date: "2026-10-05", offer: false }, { invoiceId: "M-H2", date: "2026-08-01", offer: false }] });
  const d = customerHistory("daniel@x", input);
  assert.deepEqual([d.paidInvoices, d.avgDaysLate, d.onTimeRatio, d.lifetimePaidCents, d.paymentWeekday], [3, 0, 1, 144000, 5]);
  assert.equal(d.reminderResponse, 1, "paid within 7 days of the reminder");
  const m = customerHistory("maya@x", input);
  assert.deepEqual([m.avgDaysLate, m.onTimeRatio, m.paymentWeekday, m.reminderResponse], [43.5, 0, 2, 0]);
  assert.equal(customerHistory("tom@x", input).paymentWeekday, null, "one payment is not a habit");
  assert.equal(weekdayOf(TODAY), 2);
  assert.equal(nextWeekday(TODAY, 5), "2026-11-13");
  assert.equal(nextWeekday(TODAY, 2), TODAY);
});

test("suggested day: the customer's usual weekday when pressure is moderate; today when urgent", () => {
  // Daniel, with a larger, older invoice: moderate pressure → his Friday.
  const input = demoInput({ invoices: [...demoInput().invoices.filter((i) => i.invoiceId !== "D-1043"), inv("D-9", "daniel@x", "SENT", 150000, 40)] });
  const m = moveOf(input, "D-9");
  assert.ok(m.pressure >= P.waitBelow && m.pressure < P.urgentFrom, String(m.pressure));
  assert.equal(m.day, "2026-11-13");
  assert.match(m.reason, /On Friday 2026-11-13 \(the day they usually pay\)/);
  assert.equal(moveOf(demoInput(), "M-1046").day, TODAY, "urgent: don't wait for Tuesday");
});

test("deterministic: same inputs → identical plan, whatever the input order", () => {
  const a = direct(demoInput({ cashTarget14d: 3000 }));
  const shuffled = demoInput({ cashTarget14d: 3000 });
  shuffled.invoices = [...shuffled.invoices].reverse();
  assert.deepEqual(direct(shuffled), a);
  assert.equal(JSON.stringify(direct(demoInput({ cashTarget14d: 3000 }))), JSON.stringify(a));
});

test("forecast: probability-weighted inflow within 14 days, from each customer's usual lateness, with a confidence note", () => {
  const f = direct(demoInput()).forecast;
  assert.equal(f.horizonDays, 14);
  const sum = f.byInvoice.reduce((a, b) => a + b.expectedCents, 0);
  assert.equal(f.expectedCents, sum);
  for (const b of f.byInvoice) assert.ok(b.pPaid >= P.pMin && b.pPaid <= P.pMax);
  assert.ok(f.byInvoice.find((b) => b.invoiceId === "P-1047")!.pPaid <= 0.2, "over 60 days: unlikely");
  assert.match(f.confidenceNote, /weighted estimate, not a promise/);
});

test("the demo reset's seed makes the Director choose differently per customer (built from CUSTOMERS, as the reset does)", () => {
  for (const today of ["2026-11-10", "2026-12-02", "2027-01-15"]) {
    const invoices = CUSTOMERS.flatMap((c, ci) => c.invoices.map((s) => {
      const due = addDays(today, -s.daysOverdue);
      const total = Math.round(Number(s.amount) * 100);
      const payments = s.paid ? [{ date: paymentDate(s, due, today, c.payDay), cents: total, method: "BANK_TRANSFER" }]
        : s.partial ? [{ date: addDays(today, -s.partial.daysAgo), cents: Math.round(Number(s.partial.amount) * 100), method: "BANK_TRANSFER" }] : [];
      const paid = payments.reduce((a, p) => a + p.cents, 0);
      return { invoiceId: s.n, invoiceNumber: s.n, status: s.paid ? "PAID" : s.partial ? "PARTIALLY_PAID" : "SENT", customer: `c${ci}@x`, currency: "USD",
        totalCents: total, dueCents: total - paid, invoiceDate: issueDate(due, today), dueDate: due, payments, flagged: !!s.note?.includes("Ignore previous") };
    }));
    // Worst case for the live sandbox: three paid-early $120 invoices left over from the previous seed
    // (TS-1041, TS-261110-1041, TS-261111-1041) still count in Maya's history.
    for (const k of [1, 2, 3]) {
      const due = addDays(today, -20 - k);
      invoices.push({ invoiceId: `legacy-${k}`, invoiceNumber: `legacy-${k}`, status: "PAID", customer: "c0@x", currency: "USD", totalCents: 12000, dueCents: 0,
        invoiceDate: addDays(due, -30), dueDate: due, payments: [{ date: addDays(due, -2), cents: 12000, method: "BANK_TRANSFER" }], flagged: false });
    }
    const plan = direct({ today, invoices, sends: [], received: [], paymentPlan: DEMO_POLICY.paymentPlan, cashTarget14d: DEMO_POLICY.director.cashTarget14d });
    const move = (n: string) => plan.moves.find((m) => m.invoiceId === n)!;
    assert.equal(move("1043").move, "wait", `${today}: reliable Daniel waits (${move("1043").reason})`);
    assert.equal(move("1046").move, "payment_plan", `${today}: silent high-value Maya gets a payment plan (${move("1046").reason})`);
    assert.ok(move("1046").pressure >= P.firmBelow + 3, `${today}: with a margin (${move("1046").pressure})`);
    assert.equal(move("1046").day, today, "and today, not on her usual weekday");
    assert.deepEqual([move("1045").move, move("1045").rule], ["wait", "relief"], `${today}: Tom paused after his part payment`);
    assert.equal(move("1044").move, "friendly", today);
    assert.equal(move("1047").move, "escalate", today);
    assert.ok(["friendly", "firm"].includes(move("1048").move), `${today}: injection invoice gets a reminder, never an offer`);
    const daniel = plan.customers.find((c) => c.customer === "c1@x")!.history;
    // 3 of 4 on time: the "paid this month" invoice (for monthly reports) is paid a week late on purpose.
    assert.deepEqual([daniel.onTimeRatio, daniel.paymentWeekday], [0.75, 5], `${today}: Daniel mostly pays on time, on Fridays`);
  }
});

test("planFor: tone comes from the Director's move; an offer only on a payment_plan move", () => {
  const rec = (move: string, days = 20): InvoiceRecord => ({
    invoiceId: "I", invoiceNumber: "N", status: "SENT", currency: "USD", amountTotal: "2350.00", amountDue: "2350.00", amountPaid: null, invoiceDate: null,
    dueDate: "2026-10-21", daysOverdue: days, recipientEmail: "m@x", lastReminderAt: null, severity: 2, untrusted: { recipientName: null, note: null, items: [] }, flags: [],
    director: { pressure: 50, move, day: TODAY, reason: "r" },
  });
  const p = (move: string) => planFor(rec(move), POLICY_ON) as Extract<DraftPlan, { action: "draft" }>;
  assert.equal(p("friendly").tone, "friendly", "age bucket would say firm");
  assert.equal(p("friendly").offer, null);
  assert.match(p("friendly").offerWhy, /Director's move is "friendly"/);
  assert.equal(p("payment_plan").tone, "firm");
  assert.ok(p("payment_plan").offer);
  assert.equal(p("final_notice").tone, "final_notice");
  const noDirector = { ...rec("x"), director: undefined };
  assert.equal((planFor(noDirector, POLICY_ON) as Extract<DraftPlan, { action: "draft" }>).tone, "firm", "falls back to the age bucket");
});
