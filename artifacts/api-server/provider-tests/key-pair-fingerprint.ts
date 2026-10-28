import { runKeyPairFingerprintCommand } from "./harness";

process.exitCode = runKeyPairFingerprintCommand(
  process.env,
  (text) => { process.stdout.write(text); },
  (text) => { process.stderr.write(text); },
);
