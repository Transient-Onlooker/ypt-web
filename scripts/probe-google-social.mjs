import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const HELP = `Google → YPT social login probe (local terminal only)

1. Open https://developers.google.com/oauthplayground/ yourself.
2. In Step 1 enter the scopes: openid email profile
3. Authorize, then in Step 2 exchange the code for an ACCESS token.
4. Run: node scripts/probe-google-social.mjs
5. Paste the access token only into the hidden local prompt. Never send it in chat.

The YPT exchange may create a new account. Nothing is sent to YPT until you
type SEND after Google UserInfo succeeds. No token, JWT, or profile is saved.
`;

if (process.argv.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (process.argv.length !== 2) {
  process.stderr.write("No token arguments or flags are accepted. Use --help.\n");
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("Run this probe in an interactive local terminal.\n");
  process.exit(2);
}

let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });

async function responseJson(url, options) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  let data = null;
  try {
    const raw = await response.text();
    if (raw.length < 1_000_000) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    }
  } catch {
    // Do not print a raw upstream response; it may contain private fields.
  }
  return { status: response.status, data };
}

let accessToken = "";
try {
  process.stdout.write("Google access token (hidden): ");
  muted = true;
  accessToken = (await rl.question("")).trim();
  muted = false;
  process.stdout.write("\n");
  if (!accessToken || accessToken.length > 4096) throw new Error("TOKEN_INPUT_INVALID");

  const google = await responseJson("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profile = google.data;
  if (google.status !== 200 || typeof profile?.sub !== "string" ||
      !profile.sub || typeof profile.email !== "string" || !profile.email ||
      profile.email_verified !== true)
    throw new Error("GOOGLE_USERINFO_REJECTED");
  process.stdout.write("Google UserInfo verified. Profile details are hidden.\n");
  process.stdout.write(
    "YPT exchange can create a new account for this Google identity. Type SEND to continue: ",
  );
  const choice = (await rl.question("")).trim();
  if (choice !== "SEND") {
    process.stdout.write("Cancelled before contacting YPT.\n");
  } else {
    const ypt = await responseJson("https://pi.tgclab.com/user/social/sign-up-jwt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
      },
      body: JSON.stringify({
        accessToken,
        providerId: `g${profile.sub}`,
        email: profile.email,
        loginProvider: "Google",
        new: true,
        getx: true,
        version: 810046,
      }),
    });
    const code = ypt.data?.c;
    const safeCode = Number.isSafeInteger(code) ? code : null;
    const jwt = ypt.data?.jwt;
    process.stdout.write(`YPT exchange: HTTP ${ypt.status}, success=${ypt.data?.s === true}, code=${safeCode ?? "none"}.\n`);
    if (ypt.status === 200 && ypt.data?.s === true && typeof jwt === "string" && jwt) {
      const reload = await responseJson("https://pi.tgclab.com/user/v2/reload/info", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Dart/3.11 (dart:io)",
          Authorization: `JWT ${jwt}`,
        },
        body: JSON.stringify({
          pv: 0,
          cd: { su: null, sbu: null, cu: null, eu: null, du: null, tu: null },
        }),
      });
      process.stdout.write(`YPT authenticated reload: HTTP ${reload.status}, verified=${reload.data?.s === true && !!reload.data.p && Array.isArray(reload.data.ss)}.\n`);
    }
  }
} catch (error) {
  muted = false;
  const code = error instanceof Error && [
    "TOKEN_INPUT_INVALID", "GOOGLE_USERINFO_REJECTED",
  ].includes(error.message) ? error.message : "NETWORK_OR_RESPONSE_ERROR";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
} finally {
  accessToken = "";
  rl.close();
}
