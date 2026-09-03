import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMOUS_LIMITS, parseAutonomousLimitPayload } from "../../src/core/autonomous.js";
import { createHarness, type Harness } from "./harness.js";

describe("agent session autonomous host requests", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports status without changing it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.handleAutonomousHostRequest("autonomous.get");

		expect(result.autonomous).toMatchObject({ enabled: false, continuationsUsed: 0 });
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
	});

	it("enables with limit overrides and emits an autonomous_status message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.handleAutonomousHostRequest("autonomous.enable", {
			turns: "20",
			tokens: "150k",
			time: "45m",
			continuations: 5,
		});

		expect(result.autonomous).toMatchObject({ enabled: true });
		expect(harness.session.getAutonomousStatus().limits).toEqual({
			maxTurns: 20,
			maxTokens: 150_000,
			timeoutMs: 45 * 60 * 1000,
			maxContinuations: 5,
		});
		const statusMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "autonomous_status",
		);
		expect(statusMessages).toHaveLength(1);
	});

	it("falls back to the session baseline for omitted limits", async () => {
		const harness = await createHarness({ autonomous: { maxTurns: 7 } });
		harnesses.push(harness);

		await harness.session.handleAutonomousHostRequest("autonomous.enable", { tokens: "1m" });

		const status = harness.session.getAutonomousStatus();
		expect(status.limits.maxTurns).toBe(7);
		expect(status.limits.maxTokens).toBe(1_000_000);
		expect(status.limits.maxContinuations).toBe(DEFAULT_AUTONOMOUS_LIMITS.maxContinuations);
	});

	it("refuses to re-enable while already on, so counters cannot be reset from inside", async () => {
		const harness = await createHarness({ autonomous: { enabled: true } });
		harnesses.push(harness);

		await expect(harness.session.handleAutonomousHostRequest("autonomous.enable", { turns: "99" })).rejects.toThrow(
			/already on/,
		);
		expect(harness.session.getAutonomousStatus().limits.maxTurns).toBe(DEFAULT_AUTONOMOUS_LIMITS.maxTurns);
	});

	it("disables what it armed itself", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.handleAutonomousHostRequest("autonomous.enable", {});
		const result = await harness.session.handleAutonomousHostRequest("autonomous.disable");

		expect(result.autonomous).toMatchObject({ enabled: false });
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
	});

	it("refuses to switch off unattended mode the user armed", async () => {
		const harness = await createHarness({ autonomous: { enabled: true } });
		harnesses.push(harness);

		await expect(harness.session.handleAutonomousHostRequest("autonomous.disable")).rejects.toThrow(
			/switched on by the user/,
		);
		expect(harness.session.getAutonomousStatus().enabled).toBe(true);
	});

	it("refuses to switch off a mode that is already off", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(harness.session.handleAutonomousHostRequest("autonomous.disable")).rejects.toThrow(/already off/);
	});

	it("spends one grant per session, so disable then enable cannot reset the counters", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.handleAutonomousHostRequest("autonomous.enable", { turns: "20" });
		await harness.session.handleAutonomousHostRequest("autonomous.disable");

		await expect(harness.session.handleAutonomousHostRequest("autonomous.enable", { turns: "999" })).rejects.toThrow(
			/already been armed once/,
		);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
	});

	it("hands ownership back to the user when they run the slash command", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.handleAutonomousHostRequest("autonomous.enable", {});
		await harness.session.prompt("/autonomous off");
		await harness.session.prompt("/autonomous on");

		// The mode is the user's now, so the agent cannot clear it.
		await expect(harness.session.handleAutonomousHostRequest("autonomous.disable")).rejects.toThrow(
			/switched on by the user/,
		);
		expect(harness.session.getAutonomousStatus().enabled).toBe(true);
	});

	it("rejects malformed limits with the shared usage line and leaves the mode off", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(harness.session.handleAutonomousHostRequest("autonomous.enable", { turns: "zero" })).rejects.toThrow(
			/Usage: \/autonomous/,
		);
		await expect(harness.session.handleAutonomousHostRequest("autonomous.enable", { budget: "5" })).rejects.toThrow(
			/Usage: \/autonomous/,
		);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
	});

	it("rejects an unknown autonomous request type", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(harness.session.handleAutonomousHostRequest("autonomous.reset")).rejects.toThrow(
			/unknown autonomous request type/,
		);
	});

	it("parses host-request limit payloads exactly like the slash command", () => {
		expect(parseAutonomousLimitPayload({})).toEqual({});
		expect(parseAutonomousLimitPayload({ tokens: "80k", time: "30" })).toEqual({
			maxTokens: 80_000,
			timeoutMs: 30 * 60_000,
		});
		expect(parseAutonomousLimitPayload({ turns: 12, continuations: undefined })).toEqual({ maxTurns: 12 });
		expect(() => parseAutonomousLimitPayload({ turns: true })).toThrow(/Usage: \/autonomous/);
		// A single field may not smuggle a second limit through its value.
		expect(() => parseAutonomousLimitPayload({ tokens: "80k time=99h" })).toThrow(/Usage: \/autonomous/);
	});
});
