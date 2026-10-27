import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
import type { AccessDirectory } from "@workspace/api-client-react";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }: {
    checked: boolean; onCheckedChange: () => void;
  } & React.InputHTMLAttributes<HTMLInputElement>) =>
    <input type="checkbox" checked={checked} onChange={onCheckedChange} {...props} />,
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked, onCheckedChange, ...props }: {
    checked: boolean; onCheckedChange: (checked: boolean) => void;
  } & React.InputHTMLAttributes<HTMLInputElement>) =>
    <input type="checkbox" role="switch" checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)} {...props} />,
}));
vi.mock("@/components/access/access-ui", () => ({
  FieldLabel: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  FormError: ({ message }: { message: string | null }) => message ? <p role="alert">{message}</p> : null,
  errorMessage: () => "Save failed",
  selectCls: "",
}));

import { RoleDialog } from "../src/components/access/access-dialogs";

it("shows an independent own-reports switch under every report section", async () => {
  const directory = {
    clients: [{ id: "client-a", name: "Client A" }],
    reports: [
      { id: "inbound-1", name: "Receipts", section: "inbound", sectionName: "Inbound / Receiving" },
      { id: "inventory-1", name: "Stock", section: "inventory", sectionName: "Inventory Management" },
    ],
  } as unknown as AccessDirectory;
  const save = vi.fn().mockResolvedValue(undefined);
  render(<RoleDialog open onOpenChange={vi.fn()} role={null} dir={directory}
    defaultClientId="client-a" onSave={save} />);

  const inbound = screen.getByRole("switch", { name: "Allow own reports in Inbound / Receiving" });
  const inventory = screen.getByRole("switch", { name: "Allow own reports in Inventory Management" });
  expect(inbound).not.toBeChecked();
  expect(inventory).not.toBeChecked();

  fireEvent.change(screen.getByTestId("input-role-name"), { target: { value: "Inbound Builder" } });
  fireEvent.click(inbound);
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    canCreateOwnReports: true,
    ownReportSections: ["inbound"],
  })));
});
