import { test } from "node:test";
import assert from "node:assert/strict";
import { senderAuthenticated } from "./emailAgent";

const ar = (s: string) => `mx.google.com; ${s}`;

test("DMARC pass authenticates the sender", () => {
  assert.ok(senderAuthenticated(ar("dkim=pass header.i=@acmecapital.example; spf=pass; dmarc=pass (p=NONE) header.from=acmecapital.example"), "Eli <eli@acmecapital.example>"));
});

test("a DKIM pass counts only when signed by the From domain (or its parent)", () => {
  assert.ok(senderAuthenticated(ar("dkim=pass header.i=@acmecapital.example header.s=google"), "tess@acmecapital.example"));
  assert.ok(senderAuthenticated(ar("dkim=pass header.d=acmecapital.example"), "x@mail.acmecapital.example"));
  assert.equal(senderAuthenticated(ar("dkim=pass header.i=@sendgrid.net"), "tess@acmecapital.example"), false);
  assert.equal(senderAuthenticated(ar("dkim=pass header.d=evilacmecapital.example"), "tess@acmecapital.example"), false);
});

test("no positive result — SPF alone, a DMARC fail, nothing — does not authenticate", () => {
  assert.equal(senderAuthenticated(ar("spf=pass smtp.mailfrom=acmecapital.example"), "x@acmecapital.example"), false);
  assert.equal(senderAuthenticated(ar("dkim=fail header.i=@acmecapital.example; dmarc=fail"), "x@acmecapital.example"), false);
  assert.equal(senderAuthenticated("", "x@acmecapital.example"), false);
  assert.equal(senderAuthenticated(ar("dmarc=pass"), "not-an-address"), true); // DMARC is Gmail's own From verdict
});
