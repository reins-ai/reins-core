import { describe, expect, it } from "bun:test";

import { IntegrationError } from "../../src/integrations/errors";
import {
  IntegrationStateMachine,
  type StateChangeListener,
} from "../../src/integrations/state-machine";
import { IntegrationState } from "../../src/integrations/types";

describe("IntegrationStateMachine", () => {
  describe("initial state", () => {
    it("defaults to installed", () => {
      const sm = new IntegrationStateMachine("test-integration");
      expect(sm.getState()).toBe(IntegrationState.INSTALLED);
    });

    it("accepts a custom initial state", () => {
      const sm = new IntegrationStateMachine("test-integration", IntegrationState.ACTIVE);
      expect(sm.getState()).toBe(IntegrationState.ACTIVE);
    });

    it("exposes the integration id", () => {
      const sm = new IntegrationStateMachine("obsidian-notes");
      expect(sm.getIntegrationId()).toBe("obsidian-notes");
    });
  });

  describe("valid transitions", () => {
    it("transitions from installed to configured", () => {
      const sm = new IntegrationStateMachine("test");
      const result = sm.transition(IntegrationState.CONFIGURED);
      expect(result.ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.CONFIGURED);
    });

    it("transitions from configured to connected", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.CONFIGURED);
      const result = sm.transition(IntegrationState.CONNECTED);
      expect(result.ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.CONNECTED);
    });

    it("transitions from connected to active", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.CONNECTED);
      const result = sm.transition(IntegrationState.ACTIVE);
      expect(result.ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.ACTIVE);
    });

    it("transitions from active to suspended", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.ACTIVE);
      const result = sm.transition(IntegrationState.SUSPENDED);
      expect(result.ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.SUSPENDED);
    });

    it("transitions from suspended back to active (resume)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.SUSPENDED);
      const result = sm.transition(IntegrationState.ACTIVE);
      expect(result.ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.ACTIVE);
    });

    it("transitions from disconnected to installed (reinstall)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.DISCONNECTED);
      const result = sm.transition(IntegrationState.INSTALLED);
      expect(result.ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.INSTALLED);
    });

    it("transitions through the full happy-path lifecycle", () => {
      const sm = new IntegrationStateMachine("test");

      expect(sm.transition(IntegrationState.CONFIGURED).ok).toBe(true);
      expect(sm.transition(IntegrationState.CONNECTED).ok).toBe(true);
      expect(sm.transition(IntegrationState.ACTIVE).ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.ACTIVE);
    });

    it("allows suspend and resume cycle", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.ACTIVE);

      expect(sm.transition(IntegrationState.SUSPENDED).ok).toBe(true);
      expect(sm.transition(IntegrationState.ACTIVE).ok).toBe(true);
      expect(sm.transition(IntegrationState.SUSPENDED).ok).toBe(true);
      expect(sm.transition(IntegrationState.ACTIVE).ok).toBe(true);
      expect(sm.getState()).toBe(IntegrationState.ACTIVE);
    });
  });

  describe("force disconnect from any state", () => {
    const statesExceptDisconnected = [
      IntegrationState.INSTALLED,
      IntegrationState.CONFIGURED,
      IntegrationState.CONNECTED,
      IntegrationState.ACTIVE,
      IntegrationState.SUSPENDED,
    ];

    for (const state of statesExceptDisconnected) {
      it(`allows disconnect from ${state}`, () => {
        const sm = new IntegrationStateMachine("test", state);
        const result = sm.transition(IntegrationState.DISCONNECTED);
        expect(result.ok).toBe(true);
        expect(sm.getState()).toBe(IntegrationState.DISCONNECTED);
      });
    }
  });

  describe("invalid transitions", () => {
    it("rejects installed → active (skipping configured/connected)", () => {
      const sm = new IntegrationStateMachine("test");
      const result = sm.transition(IntegrationState.ACTIVE);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IntegrationError);
        expect(result.error.message).toContain("installed");
        expect(result.error.message).toContain("active");
      }
      expect(sm.getState()).toBe(IntegrationState.INSTALLED);
    });

    it("rejects installed → connected (skipping configured)", () => {
      const sm = new IntegrationStateMachine("test");
      const result = sm.transition(IntegrationState.CONNECTED);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.INSTALLED);
    });

    it("rejects configured → active (skipping connected)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.CONFIGURED);
      const result = sm.transition(IntegrationState.ACTIVE);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.CONFIGURED);
    });

    it("rejects configured → suspended", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.CONFIGURED);
      const result = sm.transition(IntegrationState.SUSPENDED);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.CONFIGURED);
    });

    it("rejects connected → suspended (must activate first)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.CONNECTED);
      const result = sm.transition(IntegrationState.SUSPENDED);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.CONNECTED);
    });

    it("rejects suspended → connected (must resume to active first)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.SUSPENDED);
      const result = sm.transition(IntegrationState.CONNECTED);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.SUSPENDED);
    });

    it("rejects disconnected → active (must reinstall first)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.DISCONNECTED);
      const result = sm.transition(IntegrationState.ACTIVE);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.DISCONNECTED);
    });

    it("rejects disconnected → disconnected (self-transition)", () => {
      const sm = new IntegrationStateMachine("test", IntegrationState.DISCONNECTED);
      const result = sm.transition(IntegrationState.DISCONNECTED);

      expect(result.ok).toBe(false);
      expect(sm.getState()).toBe(IntegrationState.DISCONNECTED);
    });

    it("includes integration id in error message", () => {
      const sm = new IntegrationStateMachine("my-integration");
      const result = sm.transition(IntegrationState.ACTIVE);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("my-integration");
      }
    });
  });

  describe("canTransition", () => {
    it("returns true for valid transitions", () => {
      const sm = new IntegrationStateMachine("test");
      expect(sm.canTransition(IntegrationState.CONFIGURED)).toBe(true);
      expect(sm.canTransition(IntegrationState.DISCONNECTED)).toBe(true);
    });

    it("returns false for invalid transitions", () => {
      const sm = new IntegrationStateMachine("test");
      expect(sm.canTransition(IntegrationState.ACTIVE)).toBe(false);
      expect(sm.canTransition(IntegrationState.SUSPENDED)).toBe(false);
      expect(sm.canTransition(IntegrationState.CONNECTED)).toBe(false);
    });

    it("does not mutate state", () => {
      const sm = new IntegrationStateMachine("test");
      sm.canTransition(IntegrationState.ACTIVE);
      sm.canTransition(IntegrationState.CONFIGURED);
      expect(sm.getState()).toBe(IntegrationState.INSTALLED);
    });
  });

  describe("state change events", () => {
    it("notifies listener on valid transition", () => {
      const sm = new IntegrationStateMachine("test");
      let capturedId = "";
      let capturedFrom: IntegrationState | null = null;
      let capturedTo: IntegrationState | null = null;

      sm.addListener((id, from, to) => {
        capturedId = id;
        capturedFrom = from;
        capturedTo = to;
      });

      sm.transition(IntegrationState.CONFIGURED);

      expect(capturedId).toBe("test");
      expect(capturedFrom).toBe(IntegrationState.INSTALLED);
      expect(capturedTo).toBe(IntegrationState.CONFIGURED);
    });

    it("does not notify on invalid transition", () => {
      const sm = new IntegrationStateMachine("test");
      let notified = false;

      sm.addListener(() => {
        notified = true;
      });

      sm.transition(IntegrationState.ACTIVE);

      expect(notified).toBe(false);
    });

    it("notifies multiple listeners", () => {
      const sm = new IntegrationStateMachine("test");
      let count = 0;

      sm.addListener(() => count++);
      sm.addListener(() => count++);
      sm.addListener(() => count++);

      sm.transition(IntegrationState.CONFIGURED);

      expect(count).toBe(3);
    });

    it("continues notifying if a listener throws", () => {
      const sm = new IntegrationStateMachine("test");
      let secondCalled = false;

      sm.addListener(() => {
        throw new Error("Listener error");
      });
      sm.addListener(() => {
        secondCalled = true;
      });

      sm.transition(IntegrationState.CONFIGURED);

      expect(sm.getState()).toBe(IntegrationState.CONFIGURED);
      expect(secondCalled).toBe(true);
    });

    it("tracks multiple transitions", () => {
      const sm = new IntegrationStateMachine("test");
      const transitions: Array<{ from: IntegrationState; to: IntegrationState }> = [];

      sm.addListener((_id, from, to) => {
        transitions.push({ from, to });
      });

      sm.transition(IntegrationState.CONFIGURED);
      sm.transition(IntegrationState.CONNECTED);
      sm.transition(IntegrationState.ACTIVE);

      expect(transitions).toEqual([
        { from: IntegrationState.INSTALLED, to: IntegrationState.CONFIGURED },
        { from: IntegrationState.CONFIGURED, to: IntegrationState.CONNECTED },
        { from: IntegrationState.CONNECTED, to: IntegrationState.ACTIVE },
      ]);
    });

    it("removes a listener", () => {
      const sm = new IntegrationStateMachine("test");
      let count = 0;

      const listener: StateChangeListener = () => {
        count++;
      };

      sm.addListener(listener);
      sm.transition(IntegrationState.CONFIGURED);
      expect(count).toBe(1);

      sm.removeListener(listener);
      sm.transition(IntegrationState.CONNECTED);
      expect(count).toBe(1);
    });

    it("handles removing a listener that was never added", () => {
      const sm = new IntegrationStateMachine("test");
      const listener: StateChangeListener = () => {};

      // Should not throw
      sm.removeListener(listener);
      expect(sm.getState()).toBe(IntegrationState.INSTALLED);
    });

    it("does not add duplicate listeners", () => {
      const sm = new IntegrationStateMachine("test");
      let count = 0;

      const listener: StateChangeListener = () => {
        count++;
      };

      sm.addListener(listener);
      sm.addListener(listener);

      sm.transition(IntegrationState.CONFIGURED);

      expect(count).toBe(1);
    });
  });
});
