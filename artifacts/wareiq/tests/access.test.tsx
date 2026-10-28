import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AccessSession } from "@workspace/api-client-react";

type AuthState = { isLoaded: boolean; isSignedIn: boolean; userId: string | null; sessionId: string | null };
type SessionEvent = { user: { id: string } | null; session: { id: string } | null };
const clerk = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: "user_isolated_a", sessionId: "session_a" } as AuthState,
  path: "/settings",
  listener: null as ((event: SessionEvent) => void) | null,
  unsubscribe: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
  getSettings: vi.fn(),
  getOwnReports: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => clerk.auth,
  useUser: () => ({ user: clerk.auth.userId ? { id: clerk.auth.userId } : null, isLoaded: clerk.auth.isLoaded }),
  useClerk: () => ({ signOut: clerk.signOut, addListener }),
  UserButton: () => <button>Test account</button>,
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("wouter", () => ({
  useLocation: () => [clerk.path, () => {}],
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
function addListener(listener: (event: SessionEvent) => void) {
  clerk.listener = listener;
  return clerk.unsubscribe;
}

import { AdministratorAccess, SignOutButton, useAccess } from "../src/lib/access";
import { ClearUserCache } from "../src/lib/auth-provider";
import { AccessGate } from "../src/components/access-gate";
import { useOwnReportsState } from "../src/lib/own-reports-store";
import { SECTIONS } from "../src/lib/report-catalog";

// Run every authorization assertion with both legacy and populated branding.
// The logo uses a reserved test domain; all transport remains mocked below.
describe.each([
  {
    branding: "null branding",
    fields: {
      clientCompanyNumber: null, clientAddressLine1: null, clientAddressLine2: null,
      clientCity: null, clientRegion: null, clientPostalCode: null,
      clientCountry: null, clientLogoUrl: null,
    },
  },
  {
    branding: "populated branding",
    fields: {
      clientCompanyNumber: "TEST-000123",
      clientAddressLine1: "123 Test Warehouse Road",
      clientAddressLine2: "Unit 4",
      clientCity: "Test City",
      clientRegion: "Test Region",
      clientPostalCode: "TEST 123",
      clientCountry: "GB",
      clientLogoUrl: "https://branding.invalid/isolated-client-logo.png",
    },
  },
])("client access with $branding", ({ fields }) => {
function access(admin = true, status: AccessSession["status"] = "active"): AccessSession {
  return {
    status, platformAdmin: admin, canCreateOwnReports: status === "active",
    ownReportSections: status === "active" ? ["inbound"] : [],
    clientId: "client_isolated", clientName: "Isolated client",
    ...fields,
    reportIds: [SECTIONS[0].defaults[0].id], sites: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function Content() {
  const { role } = useAccess();
  return <p>Protected reporting content ({role})</p>;
}
function OwnReports() {
  const { reports } = useOwnReportsState();
  return <>{reports.map((report) => <p key={report.id}>{report.name}</p>)}</>;
}
const clients: QueryClient[] = [];
function mount(children: ReactNode = <Content />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const tree = () => <QueryClientProvider client={client}>
    <ClearUserCache /><AccessGate>{children}</AccessGate>
  </QueryClientProvider>;
  return { client, ...render(tree()), update: tree };
}
function expectLocked() {
  expect(screen.queryByText(/Protected reporting content/)).not.toBeInTheDocument();
  expect(screen.queryByText("Protected settings content")).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  clerk.auth = { isLoaded: true, isSignedIn: true, userId: "user_isolated_a", sessionId: "session_a" };
  clerk.path = "/settings";
  clerk.listener = null;
  clerk.getSession.mockReset().mockImplementation(async () => access());
  clerk.getSettings.mockReset().mockResolvedValue({ canAdminister: true });
  clerk.getOwnReports.mockReset().mockImplementation(async () => [{
    id: `report-${clerk.auth.userId}`, name: `Private report ${clerk.auth.userId}`,
  }]);
  clerk.signOut.mockReset().mockResolvedValue(undefined);
  // Keep the generated hooks and cookie-only transport real; replace only the
  // network boundary. No provider, WMS or app database requests can escape.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (url.endsWith("/api/access/me")) body = await clerk.getSession(init);
    else if (url.endsWith("/api/settings/access")) body = await clerk.getSettings(init);
    else if (url.endsWith("/api/access/own-reports")) body = await clerk.getOwnReports(init);
    else throw new Error(`Unexpected network request in isolated authorization test: ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  vi.unstubAllGlobals();
});

describe("active reporting membership guard", () => {
  it("does not fetch or show reports before Clerk loads", () => {
    clerk.auth.isLoaded = false;
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Checking your reporting access");
    expectLocked();
    expect(clerk.getSession).not.toHaveBeenCalled();
  });

  it("keeps anonymous sessions outside reporting and links to sign-in", async () => {
    clerk.auth = { isLoaded: true, isSignedIn: false, userId: null, sessionId: null };
    clerk.getSession.mockResolvedValue(access(false, "signed_out"));
    mount();
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expectLocked();
  });

  it("keeps reports hidden until the server responds", async () => {
    const pending = deferred<AccessSession>();
    clerk.getSession.mockReturnValue(pending.promise);
    mount();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expectLocked();
    await act(async () => pending.resolve(access()));
    expect(await screen.findByText("Protected reporting content (admin)")).toBeInTheDocument();
  });

  it.each(["unassigned", "disabled"] as const)("denies %s accounts", async (status) => {
    clerk.getSession.mockResolvedValue(access(false, status));
    mount();
    expect(await screen.findByRole("heading", {
      name: status === "unassigned" ? "Access awaiting approval" : "Reporting access is disabled",
    })).toBeInTheDocument();
    expectLocked();
  });

  it("allows approved non-admin reporting, without using a global supervisor claim", async () => {
    clerk.path = `${SECTIONS[0].base}/reports`;
    clerk.getSession.mockResolvedValue(access(false));
    mount();
    expect(await screen.findByText("Protected reporting content (supervisor)")).toBeInTheDocument();
  });

  it.each(["/", "/dashboard", SECTIONS[0].overview])(
    "shows approved-without-sites guidance and granted report navigation at %s", async (path) => {
      clerk.path = path;
      clerk.getSession.mockResolvedValue(access(false, "pending_sites"));
      const { rerender, update } = mount();

      expect(await screen.findByRole("heading", { name: "Isolated client · Your reports" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Your account is approved, but no imported sites are assigned yet. Report execution remains blocked until the WMS is connected and your administrator assigns sites.",
      );
      expect(screen.getByRole("link", { name: SECTIONS[0].label })).toHaveAttribute(
        "href", `${SECTIONS[0].base}/reports`,
      );
      for (const section of SECTIONS.slice(1)) {
        expect(screen.queryByRole("link", { name: section.label })).not.toBeInTheDocument();
      }
      expect(screen.queryByText("No reports have been granted to your role.")).not.toBeInTheDocument();
      expectLocked();

      // Follow the actual link target through the suite's controlled router.
      // Browsing grants is permitted; execution is separately enforced by the API.
      clerk.path = screen.getByRole("link", { name: SECTIONS[0].label }).getAttribute("href")!;
      rerender(update());
      expect(await screen.findByText("Protected reporting content (supervisor)")).toBeInTheDocument();
      expect(clerk.getSettings).not.toHaveBeenCalled();
      expect(clerk.getOwnReports).not.toHaveBeenCalled();
    },
  );

  it("removes the no-sites warning after assigned sites are revalidated", async () => {
    clerk.path = "/dashboard";
    clerk.getSession.mockResolvedValue(access(false, "pending_sites"));
    const { client } = mount();
    await screen.findByRole("heading", { name: "Isolated client · Your reports" });
    expect(screen.getByRole("status")).toHaveTextContent("Your account is approved");

    clerk.getSession.mockResolvedValue({
      ...access(false),
      sites: [{ id: "site_isolated", clientId: "client_isolated", sourceId: "warehouse_isolated",
        name: "Isolated warehouse", active: true, addressLine1: "", addressLine2: "",
        city: "", region: "", postalCode: "", country: "", contactPhone: "" }],
    } satisfies AccessSession);
    await act(async () => { await client.invalidateQueries({ queryKey: ["/api/access/me"] }); });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: SECTIONS[0].label })).toHaveAttribute(
      "href", `${SECTIONS[0].base}/reports`,
    );
  });

  it("allows administrators and uses session-keyed cookie-only no-store transport", async () => {
    const { client } = mount();
    expect(await screen.findByText("Protected reporting content (admin)")).toBeInTheDocument();
    expect(clerk.getSession).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal), credentials: "same-origin", cache: "no-store",
    }));
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    const query = client.getQueryCache().find({ queryKey: ["/api/access/me", "user_isolated_a", "session_a"] });
    expect(query?.options).toMatchObject({ staleTime: 0, refetchInterval: 15_000, refetchOnWindowFocus: "always" });
  });

  it.each([401, 403, 503])("locks reports on a failed access check (%s), without automatic retries", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "isolated failure" }), {
      status, headers: { "Content-Type": "application/json" },
    }));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Access could not be verified");
    expectLocked();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Protected reporting content (admin)")).toBeInTheDocument();
  });

  it.each(["revocation", "outage"])("removes already-visible reports on current permission %s", async (failure) => {
    const { client } = mount();
    await screen.findByText("Protected reporting content (admin)");
    if (failure === "revocation") clerk.getSession.mockResolvedValue(access(false, "disabled"));
    else clerk.getSession.mockRejectedValue(new Error("isolated provider outage"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["/api/access/me"] }); });
    if (failure === "revocation") await screen.findByRole("heading", { name: "Reporting access is disabled" });
    else expect(await screen.findByRole("alert")).toHaveTextContent("Access could not be verified");
    expectLocked();
  });
});

describe("direct report links", () => {
  const grantedSection = SECTIONS[0];
  const grantedReport = grantedSection.defaults[0];

  it("allows a direct link to an explicitly granted report", async () => {
    clerk.path = `${grantedSection.base}/reports/${grantedReport.id}`;
    clerk.getSession.mockResolvedValue(access(false));
    mount();
    expectLocked();
    expect(await screen.findByText("Protected reporting content (supervisor)")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Report access not granted" })).not.toBeInTheDocument();
  });

  it("denies a direct link to an ungranted report even with another grant in its section", async () => {
    const ungrantedReport = grantedSection.defaults[1];
    clerk.path = `${grantedSection.base}/reports/${ungrantedReport.id}`;
    clerk.getSession.mockResolvedValue(access(false));
    mount();
    expectLocked();
    expect(await screen.findByRole("heading", { name: "Report access not granted" })).toBeInTheDocument();
    expect(screen.getByText("Your role does not include this report.")).toBeInTheDocument();
    expectLocked();
  });

  it("denies a direct link into a section with no grants", async () => {
    const ungrantedSection = SECTIONS[1];
    clerk.path = `${ungrantedSection.base}/reports/${ungrantedSection.defaults[0].id}`;
    clerk.getSession.mockResolvedValue({ ...access(false), ownReportSections: [] });
    mount();
    expectLocked();
    expect(await screen.findByRole("heading", { name: "Report access not granted" })).toBeInTheDocument();
    expect(screen.getByText("Your role does not include reports in this section.")).toBeInTheDocument();
    expectLocked();
  });
});

describe("administrator settings", () => {
  const settings = <AdministratorAccess><p>Protected settings content</p></AdministratorAccess>;
  it("denies approved reporting users without requesting administrator data", async () => {
    clerk.getSession.mockResolvedValue(access(false));
    mount(settings);
    expect(await screen.findByRole("heading", { name: "Administrator access required" })).toBeInTheDocument();
    expectLocked();
    expect(clerk.getSettings).not.toHaveBeenCalled();
  });
  it("requires an independent server verification for administrators", async () => {
    const pending = deferred<{ canAdminister: boolean }>();
    clerk.getSettings.mockReturnValue(pending.promise);
    mount(settings);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Verifying administrator access"));
    expectLocked();
    await act(async () => pending.resolve({ canAdminister: true }));
    expect(await screen.findByText("Protected settings content")).toBeInTheDocument();
    expect(clerk.getSettings).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal), credentials: "same-origin", cache: "no-store",
    }));
  });
  it.each(["denied", "outage"])("keeps settings locked on %s despite admin approval", async (failure) => {
    if (failure === "denied") clerk.getSettings.mockResolvedValue({ canAdminister: false });
    else clerk.getSettings.mockRejectedValue(new Error("isolated failure"));
    mount(settings);
    await screen.findByRole("heading", { name: "Settings are locked" });
    expectLocked();
    clerk.getSettings.mockResolvedValue({ canAdminister: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Protected settings content")).toBeInTheDocument();
  });
  it("locks already-open settings when revalidation fails", async () => {
    const { client } = mount(settings);
    await screen.findByText("Protected settings content");
    clerk.getSettings.mockRejectedValue(new Error("test HTTP 403"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["wareiq-settings-access"] }); });
    await screen.findByRole("heading", { name: "Settings are locked" });
    expectLocked();
  });
});

describe("compatibility permissions after revalidation", () => {
  function Permissions() {
    const { canAdminister, canReport, role } = useAccess();
    return <output>{`${canAdminister}:${canReport}:${role}`}</output>;
  }
  it.each([401, 503])("does not reuse stale administrator approval after HTTP %s", async (status) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><Permissions /></QueryClientProvider>);
    await screen.findByText("true:true:admin");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: "isolated denial" }), {
      status, headers: { "Content-Type": "application/json" },
    }));
    await act(async () => { await client.invalidateQueries({ queryKey: ["/api/access/me"] }); });
    expect(await screen.findByText("false:false:unassigned")).toBeInTheDocument();
    // Make sure this actually exercised a retained prior success.
    expect(client.getQueryCache().find({ queryKey: ["/api/access/me"], exact: false })?.state.data).toEqual(access());
  });
});

describe("sign-out and session isolation", () => {
  it("clears cached report data BEFORE asking Clerk to sign out", async () => {
    const { client } = mount(<SignOutButton />);
    await screen.findByRole("button", { name: "Sign out" });
    client.setQueryData(["sensitive-report"], { rows: ["isolated-row-a"] });
    const cancel = vi.spyOn(client, "cancelQueries");
    const clear = vi.spyOn(client, "clear");
    clerk.signOut.mockImplementation(async (options) => {
      expect(cancel).toHaveBeenCalled();
      expect(clear).toHaveBeenCalled();
      expect(client.getQueryCache().getAll()).toHaveLength(0);
      expect(options).toEqual({ redirectUrl: "/" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(clerk.signOut).toHaveBeenCalledOnce());
  });
  it("disables duplicate sign-outs and allows retry after provider failure", async () => {
    const pending = deferred<void>();
    clerk.signOut.mockReturnValueOnce(pending.promise);
    mount(<SignOutButton />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    await act(async () => pending.reject(new Error("isolated sign-out failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-out failed. Please retry.");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(clerk.signOut).toHaveBeenCalledTimes(2));
  });
  it.each(["sign-out", "account switch", "same-account new session"])(
    "cancels in-flight requests and purges report caches on %s", async (transition) => {
      const { client } = mount();
      await screen.findByText("Protected reporting content (admin)");
      client.setQueryData(["sensitive-report"], "private-row-a");
      let aborted = false;
      const inFlight = client.fetchQuery({
        queryKey: ["in-flight-report"],
        queryFn: ({ signal }) => new Promise(() => {
          signal.addEventListener("abort", () => { aborted = true; });
        }),
      }).catch(() => undefined);
      const nextUser = transition === "sign-out" ? null : { id: transition === "account switch" ? "user_isolated_b" : "user_isolated_a" };
      await act(async () => {
        clerk.listener!({ user: nextUser, session: nextUser ? { id: "session_b" } : null });
      });
      expect(aborted).toBe(true);
      await inFlight;
      expect(client.getQueryData(["sensitive-report"])).toBeUndefined();
      expect(client.getQueryData(["in-flight-report"])).toBeUndefined();
    },
  );
  it("never reuses the previous session's permission response for a new session", async () => {
    const { rerender, update } = mount();
    await screen.findByText("Protected reporting content (admin)");
    const pending = deferred<AccessSession>();
    clerk.getSession.mockReturnValue(pending.promise);
    clerk.auth = { ...clerk.auth, sessionId: "session_b" };
    rerender(update());
    expect(screen.getByRole("status")).toHaveTextContent("Checking your reporting access");
    expectLocked();
    await act(async () => pending.resolve(access(false, "unassigned")));
    await screen.findByRole("heading", { name: "Access awaiting approval" });
    expectLocked();
  });
  it("isolates server-backed own-report caches across accounts and unsubscribes on unmount", async () => {
    const { rerender, update, unmount } = mount(<OwnReports />);
    await screen.findByText("Private report user_isolated_a");
    const pending = deferred<AccessSession>();
    clerk.getSession.mockReturnValue(pending.promise);
    await act(async () => {
      clerk.auth = { ...clerk.auth, userId: "user_isolated_b", sessionId: "session_b" };
      clerk.listener!({ user: { id: "user_isolated_b" }, session: { id: "session_b" } });
      rerender(update());
    });
    expect(screen.queryByText("Private report user_isolated_a")).not.toBeInTheDocument();
    await act(async () => pending.resolve(access()));
    expect(await screen.findByText("Private report user_isolated_b")).toBeInTheDocument();
    expect(screen.queryByText("Private report user_isolated_a")).not.toBeInTheDocument();
    unmount();
    expect(clerk.unsubscribe).toHaveBeenCalled();
  });
});
});
