import { describe, expect, it, vi } from "vitest";
import { ViewRegistry } from "../src/view-registry";

describe("ViewRegistry", () => {
	it("renders every open view", () => {
		const registry = new ViewRegistry<{ render(): void }>();
		const first = { render: vi.fn() };
		const second = { render: vi.fn() };

		registry.add(first);
		registry.add(second);
		registry.renderAll();

		expect(first.render).toHaveBeenCalledOnce();
		expect(second.render).toHaveBeenCalledOnce();
	});

	it("does not retain or render a closed view", () => {
		const registry = new ViewRegistry<{ render(): void }>();
		const closed = { render: vi.fn() };
		const open = { render: vi.fn() };

		registry.add(closed);
		registry.add(open);
		registry.delete(closed);
		registry.renderAll();

		expect(closed.render).not.toHaveBeenCalled();
		expect(open.render).toHaveBeenCalledOnce();
		expect(registry.size).toBe(1);
	});
});
