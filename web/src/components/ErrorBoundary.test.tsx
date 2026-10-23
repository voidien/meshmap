// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new Error("kaboom");
}

describe("error boundary", () => {
  it("shows a message and a reload button instead of a blank page", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = document.createElement("div");
    await act(async () => {
      createRoot(host).render(createElement(ErrorBoundary, null, createElement(Boom)));
    });
    expect(host.querySelector("#crash-screen")).not.toBeNull();
    expect(host.textContent).toContain("kaboom");
    expect(host.textContent).toContain("Reload the page");
    spy.mockRestore();
  });

  it("renders its children when nothing is wrong", async () => {
    const host = document.createElement("div");
    await act(async () => {
      createRoot(host).render(createElement(ErrorBoundary, null, createElement("p", null, "fine")));
    });
    expect(host.textContent).toBe("fine");
  });
});
