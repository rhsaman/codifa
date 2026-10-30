// Unit tests for the microphone lease in src/lib/liveVoiceState.ts.
// The lease is what keeps one spoken sentence from becoming a message in two
// chats at once; these tests pin the exact semantics the panels rely on.
// Run: bash tests/run-frontend.sh (entry: liveVoiceLease)

import {
  claimLiveVoice,
  isLiveVoiceBusy,
  liveVoiceLeaseHolder,
  releaseLiveVoice,
  syncLiveVoiceLease,
} from "../src/lib/liveVoiceState";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failed++;
    console.error(`  FAIL - ${name}`, extra ?? "");
  }
}

// The lease is module state: release it before each scenario so the tests are
// order-independent.
function reset(): void {
  releaseLiveVoice(null);
}

console.log("1) claim / release basics:");
{
  reset();
  check("the lease starts free", liveVoiceLeaseHolder() === null);
  check("a chat can claim a free mic", claimLiveVoice("chat-a") === true);
  check("the holder is visible without claiming", liveVoiceLeaseHolder() === "chat-a");
  check("a second chat is refused", claimLiveVoice("chat-b") === false);
  check("the holder did not change", liveVoiceLeaseHolder() === "chat-a");
  check("the same chat re-claims as a no-op", claimLiveVoice("chat-a") === true);
  releaseLiveVoice("chat-a");
  check("release frees the lease", liveVoiceLeaseHolder() === null);
  check("the refused chat can claim now", claimLiveVoice("chat-b") === true);
  releaseLiveVoice("chat-b");
}

console.log("2) a session refused at connect must not wipe the holder's lease:");
{
  reset();
  claimLiveVoice("chat-a");
  // LocalLiveSession.disconnect() used to call releaseLiveVoice(null) when it
  // never held a lease — unconditionally clearing the dictating chat's lease
  // out from under it. The caller-side guard now prevents that; the no-arg
  // release stays an explicit global reset, the id-ed one is scoped.
  releaseLiveVoice("chat-b");
  check("a scoped release for a non-holder is a no-op", liveVoiceLeaseHolder() === "chat-a");
  releaseLiveVoice("chat-a");
  check("the holder's own release works", liveVoiceLeaseHolder() === null);
}

console.log("3) syncLiveVoiceLease binds, never steals:");
{
  reset();
  // The dictate session in chat A holds the mic; the store knows nothing
  // about it (dictate does not write live-voice state).
  claimLiveVoice("chat-a");
  // Chat B's startLive stamped 'connecting' into the store, then lost the
  // claim inside connect(): its ownership effect syncs (B, busy=true).
  syncLiveVoiceLease("chat-b", true);
  check("a busy sync cannot steal the lease", liveVoiceLeaseHolder() === "chat-a", {
    holder: liveVoiceLeaseHolder(),
  });
  // The real owner syncing its own busy state keeps the binding.
  syncLiveVoiceLease("chat-a", true);
  check("the holder re-binding to itself is a no-op", liveVoiceLeaseHolder() === "chat-a");
  // A free lease is claimed by the sync (covers an owner panel that mounted
  // into an already-busy store).
  releaseLiveVoice("chat-a");
  syncLiveVoiceLease("chat-c", true);
  check("a free lease is bound by the sync", liveVoiceLeaseHolder() === "chat-c");
  syncLiveVoiceLease("chat-c", false);
  check("the not-busy sync releases", liveVoiceLeaseHolder() === null);
}

console.log("4) busy-state classification:");
{
  check("connecting is busy", isLiveVoiceBusy("connecting") === true);
  check("live is busy", isLiveVoiceBusy("live") === true);
  check("speaking is busy", isLiveVoiceBusy("speaking") === true);
  check("idle is not busy", isLiveVoiceBusy("idle") === false);
  check("closed is not busy", isLiveVoiceBusy("closed") === false);
  check("error is not busy", isLiveVoiceBusy("error") === false);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall live voice lease checks passed");
