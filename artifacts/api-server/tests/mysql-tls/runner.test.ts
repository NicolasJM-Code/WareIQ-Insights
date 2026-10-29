import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.skipIf(process.env.WMS_MYSQL_TLS_RUNNER_CHECK !== "1")(
  "the TLS fixture runner enables both integration suites",
  () => {
    expect(process.env.WMS_MYSQL_TLS_INTEGRATION).toBe("1");
    expect(process.env.WMS_OPENVPN_MYSQL_TLS_INTEGRATION).toBe("1");
    expect(process.env.WMS_MYSQL_TLS_FIXTURE_VERSION).toMatch(/^8\.(0|4)\.\d+/);
  },
);

test("fixture recovery removes an orphaned fixture volume but preserves unrelated volumes", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "mysql-tls-recovery-test-"));
  const fixtureDir = join(tempRoot, "wareiq-mysql-tls.Orphan123");
  const fakeBin = join(tempRoot, "bin");
  const dockerLog = join(tempRoot, "docker.log");
  const ownerPid = "4000000000";
  const projectName = `wareiq-mysql-tls-${ownerPid}`;
  const activeOwnerPid = String(process.pid);
  const activeProjectName = `wareiq-mysql-tls-${activeOwnerPid}`;
  const activeFixtureDir = join(tempRoot, "wareiq-mysql-tls.Active123");
  mkdirSync(fixtureDir);
  mkdirSync(activeFixtureDir);
  mkdirSync(fakeBin);
  writeFileSync(join(fixtureDir, ".runner.lock"), "");
  writeFileSync(join(activeFixtureDir, ".runner.lock"), "");
  const dockerPath = join(fakeBin, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${DOCKER_TEST_LOG:?}"
case "$1 $2" in
  "compose version") exit 0 ;;
  "ps --all") exit 0 ;;
  "volume ls")
    printf '%s\\n' orphan-volume active-volume unrelated-volume
    ;;
  "volume inspect")
    case "\${@: -1}" in
      orphan-volume)
        printf '%s\\n' '${projectName}|true|${ownerPid}|${fixtureDir}|mysql|${projectName}_mysql-data'
        ;;
      active-volume)
        printf '%s\\n' '${activeProjectName}|true|${activeOwnerPid}|${activeFixtureDir}|mysql|${activeProjectName}_mysql-data'
        ;;
      unrelated-volume)
        printf '%s\\n' 'another-project|false|12345|/tmp/unrelated|mysql|another-project_mysql-data'
        ;;
      *) exit 1 ;;
    esac
    ;;
  "volume rm")
    printf '%s\\n' "\${@: -1}" >> "\${DOCKER_REMOVED_VOLUMES:?}"
    ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(dockerPath, 0o755);

  try {
    const runner = fileURLToPath(new URL("./run.sh", import.meta.url));
    execFileSync("bash", [runner], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: tempRoot,
        DOCKER_TEST_LOG: dockerLog,
        DOCKER_REMOVED_VOLUMES: join(tempRoot, "removed-volumes"),
        WMS_MYSQL_TLS_RECOVERY_CHECK: "1",
      },
      stdio: "pipe",
    });
    expect(readFileSync(join(tempRoot, "removed-volumes"), "utf8")).toBe("orphan-volume\n");
    expect(readFileSync(dockerLog, "utf8")).toContain("volume rm orphan-volume");
    expect(readFileSync(dockerLog, "utf8")).not.toContain("volume rm unrelated-volume");
    expect(readFileSync(dockerLog, "utf8")).not.toContain("volume rm active-volume");
    expect(existsSync(fixtureDir)).toBe(false);
    expect(existsSync(activeFixtureDir)).toBe(true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
