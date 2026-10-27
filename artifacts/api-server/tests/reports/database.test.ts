import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { socketDirectory, startDatabase } from "./database";

describe("private report database cleanup", () => {
  it("stops PostgreSQL and removes its temporary directory after schema setup fails", async () => {
    let serverPid: number | undefined;

    await expect(startDatabase({
      afterStart: () => {
        serverPid = Number(readFileSync(join(socketDirectory, "data", "postmaster.pid"), "utf8").split("\n")[0]);
        throw new Error("controlled schema setup failure");
      },
    })).rejects.toThrow("controlled schema setup failure");

    expect(serverPid).toBeGreaterThan(0);
    expect(() => process.kill(serverPid!, 0)).toThrow();
    expect(existsSync(socketDirectory)).toBe(false);
  });
});
