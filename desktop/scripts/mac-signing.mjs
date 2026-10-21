// Sets up signing for the macOS builds made on GitHub (.github/workflows/release.yml). Works
// from Windows: it needs openssl (Git for Windows has it) and the GitHub CLI, signed in.
//
//   node scripts/mac-signing.mjs request
//       Makes a private key and a certificate signing request in desktop/.signing/ (git-ignored).
//       Upload signing-request.csr at developer.apple.com → Certificates → + → Developer ID
//       Application, then download the certificate (developerID_application.cer).
//
//   node scripts/mac-signing.mjs secrets <path to developerID_application.cer> --apple-id <Apple ID email>
//       Packs the key and certificate into a .p12 and stores the repository's signing secrets
//       with `gh secret set`. For notarization it then waits for an app-specific password of that
//       Apple ID (account.apple.com → Sign-In and Security → App-Specific Passwords) to be copied.
//
// Nothing secret is printed. Keep desktop/.signing/ backed up until the certificate expires (it
// says when in the Apple account); Apple allows only a few Developer ID certificates per account.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../.signing/", import.meta.url));
const keyFile = `${dir}developer-id.key`;
const csrFile = `${dir}signing-request.csr`;
const certFile = `${dir}developer-id.pem`;
const chainFile = `${dir}apple-developer-id-g2.pem`;
const p12File = `${dir}developer-id.p12`;
const appleCa = "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer";

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};
const openssl = (args, options = {}) =>
  execFileSync("openssl", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });

if (command === "request") {
  mkdirSync(dir, { recursive: true });
  if (existsSync(keyFile) && !rest.includes("--force")) {
    console.error(`${keyFile} already exists. Use it, or pass --force to start over.`);
    process.exit(1);
  }
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", csrFile, "-subj", "/CN=UrBudget Developer ID"]);
  console.log(`Made ${csrFile}`);
  console.log("Upload it at developer.apple.com → Certificates → + → Developer ID Application, then download the certificate.");
} else if (command === "secrets") {
  const cer = rest[0];
  const appleId = flag("--apple-id");
  if (!cer || cer.startsWith("--") || !appleId) {
    console.error("Usage: node scripts/mac-signing.mjs secrets <developerID_application.cer> --apple-id <Apple ID email>");
    process.exit(1);
  }
  if (!existsSync(keyFile)) {
    console.error(`No ${keyFile}: the certificate has to come from this computer's signing request.`);
    process.exit(1);
  }

  // Apple's download is DER; accept PEM too.
  const raw = readFileSync(cer);
  const inform = raw.subarray(0, 10).toString() === "-----BEGIN" ? "PEM" : "DER";
  openssl(["x509", "-inform", inform, "-in", cer, "-out", certFile]);
  const subject = openssl(["x509", "-in", certFile, "-noout", "-subject", "-nameopt", "RFC2253,-esc_msb,utf8"]);
  const identity = subject.match(/CN=((?:\\,|[^,])+)/)?.[1].replace(/\\,/g, ",").trim();
  const team = subject.match(/OU=([A-Z0-9]{10})/)?.[1];
  if (!identity?.startsWith("Developer ID Application:") || !team) {
    console.error(`That isn't a Developer ID Application certificate (${subject.trim()}).`);
    process.exit(1);
  }
  const keyModulus = openssl(["rsa", "-in", keyFile, "-noout", "-modulus"]);
  const certModulus = openssl(["x509", "-in", certFile, "-noout", "-modulus"]);
  if (keyModulus !== certModulus) {
    console.error("That certificate wasn't made from this computer's signing request.");
    process.exit(1);
  }

  // Include Apple's intermediate so codesign can build the chain on GitHub's machines.
  const ca = Buffer.from(await (await fetch(appleCa)).arrayBuffer());
  writeFileSync(`${chainFile}.cer`, ca);
  openssl(["x509", "-inform", "DER", "-in", `${chainFile}.cer`, "-out", chainFile]);

  // 3DES and SHA-1 keep the .p12 readable by macOS's `security import`.
  const password = randomBytes(24).toString("base64url");
  openssl(
    ["pkcs12", "-export", "-inkey", keyFile, "-in", certFile, "-certfile", chainFile, "-out", p12File,
      "-name", identity, "-passout", "env:P12_PASSWORD",
      "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"],
    { env: { ...process.env, P12_PASSWORD: password } },
  );

  console.log(`Certificate: ${identity}`);
  console.log("Now make an app-specific password for notarization: account.apple.com → Sign-In and Security →");
  console.log("App-Specific Passwords → +, name it \"UrBudget notarization\", and copy it. Waiting for it…");
  const appPassword = await fromClipboard(/\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/);
  console.log("Got it.");

  const secrets = {
    APPLE_CERTIFICATE: readFileSync(p12File).toString("base64"),
    APPLE_CERTIFICATE_PASSWORD: password,
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_TEAM_ID: team,
    APPLE_ID: appleId,
    APPLE_PASSWORD: appPassword,
  };
  for (const [name, value] of Object.entries(secrets)) {
    execFileSync("gh", ["secret", "set", name], { input: value, stdio: ["pipe", "inherit", "inherit"] });
  }
  console.log("Stored the six signing secrets. Run the Release workflow from GitHub's Actions tab.");
} else {
  console.error("Usage: node scripts/mac-signing.mjs request | secrets <developerID_application.cer> --apple-id <email>");
  process.exit(1);
}

/** Resolves with the first match for `pattern` copied to the clipboard (checked every second). */
async function fromClipboard(pattern) {
  const read =
    process.platform === "win32"
      ? () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : () => execFileSync("pbpaste", { encoding: "utf8" });
  for (;;) {
    try {
      const found = read().match(pattern)?.[0];
      if (found) return found;
    } catch {
      // Try again in a second.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
