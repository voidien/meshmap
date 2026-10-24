// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberField } from "./NumberField";
import { clearToasts, notify, Toasts } from "./toasts";
import { ConfirmHost, confirmDialog } from "./confirm";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => act(() => root.unmount()) };
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  clearToasts();
});

describe("NumberField", () => {
  it("waits for the end of typing, so clearing and retyping works", () => {
    const seen: number[] = [];
    const { host } = mount(createElement(NumberField, { value: 10, onCommit: (v: number) => seen.push(v), min: 0, max: 100 }));
    const input = host.querySelector("input")!;
    act(() => input.focus());
    type(input, "");
    type(input, "1");
    type(input, "12");
    expect(seen).toEqual([]);
    act(() => input.blur());
    expect(seen).toEqual([12]);
  });
  it("refuses a value out of range, says why, and keeps the old one", () => {
    const seen: number[] = [];
    const { host } = mount(createElement(NumberField, { value: 10, onCommit: (v: number) => seen.push(v), min: 0, max: 100 }));
    const input = host.querySelector("input")!;
    act(() => input.focus());
    type(input, "500");
    act(() => input.blur());
    expect(seen).toEqual([]);
    expect(input.value).toBe("10");
    expect(host.querySelector("[role=alert]")?.textContent).toMatch(/At most 100/);
  });
  it("steps with the arrow keys and accepts a comma", () => {
    const seen: number[] = [];
    const { host } = mount(createElement(NumberField, { value: 5, onCommit: (v: number) => seen.push(v), step: 0.5 }));
    const input = host.querySelector("input")!;
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(seen).toEqual([5.5]);
    act(() => input.focus());
    type(input, "7,25");
    act(() => input.blur());
    expect(seen).toEqual([5.5, 7.25]);
  });
});

describe("toasts", () => {
  it("shows a message with an action and removes it once the action is used", () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    const { host } = mount(createElement(Toasts));
    act(() => void notify("Deleted “Alpha”", { action: "Undo", onAction: undo }));
    expect(host.textContent).toContain("Deleted “Alpha”");
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
    act(() => button.click());
    expect(undo).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("Alpha");
    act(() => void notify("short lived"));
    act(() => void vi.advanceTimersByTime(6000));
    expect(host.textContent).not.toContain("short lived");
    vi.useRealTimers();
  });
});

describe("confirm dialog", () => {
  it("resolves true on confirm and false on Esc", async () => {
    mount(createElement(ConfirmHost));
    let result: Promise<boolean> = Promise.resolve(false);
    act(() => void (result = confirmDialog({ body: "Delete it?", confirm: "Delete" })));
    expect(document.body.textContent).toContain("Delete it?");
    act(() => void [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click());
    expect(await result).toBe(true);
    act(() => void (result = confirmDialog("Again?")));
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(await result).toBe(false);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
