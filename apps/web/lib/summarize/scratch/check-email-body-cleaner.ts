// Scratch check for email-body-cleaner. No test runner in this repo, so this
// follows the packages/services/scratch convention:
//
//   pnpm dlx tsx apps/web/lib/summarize/scratch/check-email-body-cleaner.ts
//
// Prints a pass/fail line per case and exits non-zero on any failure.

import { cleanEmailBody } from "../email-body-cleaner.ts";

interface Case {
  name: string;
  input: string;
  expect: string;
  expectCutBy?: string | null;
  expectForward?: boolean;
}

const cases: Case[] = [
  {
    name: "gmail quote (the format this app's own replies emit)",
    input: [
      "Sounds good, shipping today.",
      "",
      "On Sat, Jul 11, 2026 at 4:14 PM Shriyansh Agarwal <a@b.com> wrote:",
      "",
      "Please review the proposal.",
    ].join("\n"),
    expect: "Sounds good, shipping today.",
    expectCutBy: "gmail-on-wrote",
  },
  {
    name: "outlook header block",
    input: [
      "Approved.",
      "",
      "From: Someone <s@x.com>",
      "Sent: Monday, 1 June 2026 09:00",
      "To: Me",
      "Subject: Proposal",
      "",
      "Original text here.",
    ].join("\n"),
    expect: "Approved.",
    expectCutBy: "outlook-header-block",
  },
  {
    name: "prose starting with 'From:' is NOT treated as a header block",
    input: "From: the numbers we saw last quarter, growth looks flat.",
    expect: "From: the numbers we saw last quarter, growth looks flat.",
    expectCutBy: null,
  },
  {
    name: "outlook underscore rule",
    input: ["Done.", "", "________________________________", "", "Old thread."].join("\n"),
    expect: "Done.",
    expectCutBy: "outlook-rule",
  },
  {
    name: "quote-prefixed lines without an attribution line",
    input: ["Agreed.", "> what do you think?", "> - Rahul"].join("\n"),
    expect: "Agreed.",
    expectCutBy: null,
  },
  {
    name: "signature delimiter and device footer",
    input: ["Here are the numbers.", "", "-- ", "Rahul", "VP Finance"].join("\n"),
    expect: "Here are the numbers.",
    expectCutBy: "sig-delimiter",
  },
  {
    name: "sent from my iPhone",
    input: ["ok", "", "Sent from my iPhone"].join("\n"),
    expect: "ok",
    expectCutBy: "sent-from-device",
  },
  {
    name: "earliest marker wins when several are present",
    input: [
      "Real content.",
      "",
      "On Mon, Jun 1, 2026 at 9:00 AM Someone <s@x.com> wrote:",
      "",
      "-- ",
      "sig inside the quoted part",
    ].join("\n"),
    expect: "Real content.",
    expectCutBy: "gmail-on-wrote",
  },
  {
    name: "a one-word body survives (short is not empty)",
    input: "Test",
    expect: "Test",
    expectCutBy: null,
  },
  {
    name: "CRLF and nbsp normalization",
    input: "Line one.\r\n\r\n\r\n\r\nLine two.",
    expect: "Line one.\n\nLine two.",
    expectCutBy: null,
  },
  {
    name: "empty input",
    input: "",
    expect: "",
    expectCutBy: null,
  },
  // ── Forwards: the content is the payload, never cut it ────────────────
  {
    name: "gmail forward keeps the forwarded body (the regression)",
    input: [
      "doing test",
      "",
      "---------- Forwarded message ---------",
      "From: Smog I am <iamsmogger@gmail.com>",
      "Date: Fri, 31 Jul 2026 10:37:28 +0200",
      "Subject: Re: From mailroid App",
      "To: iamsmogger@gmail.com",
      "",
      "Absolutely. I've rewritten these to sound like they came from a Big 4",
      "consulting engagement.",
      "",
      "Technology Consulting & Business Analysis Project",
      "Executed an end-to-end technology consulting engagement.",
    ].join("\n"),
    expect: [
      "doing test",
      "",
      "---------- Forwarded message ---------",
      "From: Smog I am <iamsmogger@gmail.com>",
      "Date: Fri, 31 Jul 2026 10:37:28 +0200",
      "Subject: Re: From mailroid App",
      "To: iamsmogger@gmail.com",
      "",
      "Absolutely. I've rewritten these to sound like they came from a Big 4",
      "consulting engagement.",
      "",
      "Technology Consulting & Business Analysis Project",
      "Executed an end-to-end technology consulting engagement.",
    ].join("\n"),
    expectCutBy: null,
    expectForward: true,
  },
  {
    name: "apple 'Begin forwarded message:' is kept",
    input: [
      "FYI",
      "",
      "Begin forwarded message:",
      "",
      "From: Someone <s@x.com>",
      "Subject: Q3 numbers",
      "",
      "Revenue was 4.2M, up 12%.",
    ].join("\n"),
    expect: [
      "FYI",
      "",
      "Begin forwarded message:",
      "",
      "From: Someone <s@x.com>",
      "Subject: Q3 numbers",
      "",
      "Revenue was 4.2M, up 12%.",
    ].join("\n"),
    expectCutBy: null,
    expectForward: true,
  },
  {
    name: "a signature inside a forward does not truncate the payload",
    input: [
      "passing this on",
      "",
      "---------- Forwarded message ---------",
      "From: Rahul <r@x.com>",
      "",
      "Numbers attached.",
      "",
      "-- ",
      "Rahul",
      "",
      "The deadline is 14 August.",
    ].join("\n"),
    expect: [
      "passing this on",
      "",
      "---------- Forwarded message ---------",
      "From: Rahul <r@x.com>",
      "",
      "Numbers attached.",
      "",
      "-- ",
      "Rahul",
      "",
      "The deadline is 14 August.",
    ].join("\n"),
    expectCutBy: null,
    expectForward: true,
  },
  {
    name: "a REPLY is still cut (forwards are the exception, not the rule)",
    input: [
      "Approved.",
      "",
      "-----Original Message-----",
      "Please approve the budget.",
    ].join("\n"),
    expect: "Approved.",
    expectCutBy: "original-message",
    expectForward: false,
  },
];

let failed = 0;

for (const c of cases) {
  const got = cleanEmailBody(c.input);
  const textOk = got.text === c.expect;
  const cutOk = c.expectCutBy === undefined || got.cutBy === c.expectCutBy;
  const fwdOk = c.expectForward === undefined || got.isForward === c.expectForward;

  if (textOk && cutOk && fwdOk) {
    console.log(`✅ ${c.name}`);
  } else {
    failed++;
    console.error(`❌ ${c.name}`);
    if (!textOk) {
      console.error(`   expected text: ${JSON.stringify(c.expect)}`);
      console.error(`   got text:      ${JSON.stringify(got.text)}`);
    }
    if (!cutOk) {
      console.error(`   expected cutBy: ${c.expectCutBy}, got: ${got.cutBy}`);
    }
    if (!fwdOk) {
      console.error(`   expected isForward: ${c.expectForward}, got: ${got.isForward}`);
    }
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed > 0 ? 1 : 0);
