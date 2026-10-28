import { runKeyPairAttestationCheckCommand } from "./harness";

process.exitCode = runKeyPairAttestationCheckCommand(
  process.env,
  (text) => { process.stdout.write(text); },
);
