// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette } from "@paperclipai/shared";
import { AgentAvatarField } from "./AgentAvatarField";

const uploadImage = vi.hoisted(() => vi.fn());
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const agent = { id: "agent-1", name: "Portrait", appearance: appearanceForPalette("deep-tide") };
const assetId = "11111111-1111-4111-8111-111111111111";
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(value: string | null, onChange: (assetId: string | null) => void) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <AgentAvatarField agent={agent} value={value} onChange={onChange} />
    </QueryClientProvider>,
  ));
}

async function chooseFile(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("AgentAvatarField", () => {
  it("uploads an image into the agent namespace and reports the new asset id", async () => {
    uploadImage.mockResolvedValue({ assetId, contentPath: `/api/assets/${assetId}/content` });
    const onChange = vi.fn();
    await render(null, onChange);
    expect(host.textContent).toContain("Upload photo");
    await chooseFile(new File(["png"], "portrait.png", { type: "image/png" }));
    expect(uploadImage).toHaveBeenCalledWith("company-1", expect.any(File), "agents/agent-1/avatar");
    expect(onChange).toHaveBeenCalledWith(assetId);
  });

  it("rejects unsupported files without uploading", async () => {
    const onChange = vi.fn();
    await render(null, onChange);
    await chooseFile(new File(["pdf"], "notes.pdf", { type: "application/pdf" }));
    expect(uploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Upload a PNG, JPEG, WEBP, or GIF image.");
  });

  it("previews the current avatar and clears it on remove", async () => {
    const onChange = vi.fn();
    await render(assetId, onChange);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(`/api/assets/${assetId}/content`);
    expect(host.textContent).toContain("Change photo");
    const remove = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Remove"))!;
    await act(async () => { remove.click(); });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows the upload error", async () => {
    uploadImage.mockRejectedValue(new Error("Unsupported file type: image/heic"));
    await render(null, vi.fn());
    await chooseFile(new File(["gif"], "portrait.gif", { type: "image/gif" }));
    expect(host.textContent).toContain("Unsupported file type: image/heic");
  });
});
