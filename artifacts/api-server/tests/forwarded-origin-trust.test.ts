import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  forwardedOriginTrustMiddleware,
  parseTrustedProxyCidrs,
} from "../src/middlewares/clerkProxyMiddleware";

function mockRequest(remoteAddress: string, headers: Record<string, string> = {}) {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request;
}

function mockResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}

describe("forwarded origin trust boundary", () => {
  const trustedNetworks = parseTrustedProxyCidrs("10.24.0.0/16");

  it("accepts forwarded public origin headers from the configured ingress", () => {
    const req = mockRequest("10.24.5.9", {
      "x-forwarded-host": "wareiq.test",
      "x-forwarded-proto": "https",
    });
    const res = mockResponse();
    const next = vi.fn();

    forwardedOriginTrustMiddleware(trustedNetworks)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects the same forwarded origin headers from a direct, untrusted caller", () => {
    const req = mockRequest("192.0.2.44", {
      "x-forwarded-host": "wareiq.test",
      "x-forwarded-proto": "https",
    });
    const res = mockResponse();
    const next = vi.fn();

    forwardedOriginTrustMiddleware(trustedNetworks)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forwarded origin headers require a trusted proxy.",
    });
  });

  it("fails closed for malformed proxy network configuration", () => {
    expect(() => parseTrustedProxyCidrs("not-a-network")).toThrow(
      'TRUSTED_PROXY_CIDRS contains an invalid network: "not-a-network".',
    );
  });
});
