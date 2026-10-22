import { Command, CommanderError } from "@commander-js/extra-typings";
import { expect, test } from "vitest";
import { actionDescription } from "./command.js";

test("deployment selectors reject conflicting targets before the action", () => {
  const selectors = [
    ["--prod"],
    ["--preview-name", "preview"],
    ["--deployment-name", "example-deployment"],
    ["--deployment", "staging"],
    ["--url", "http://127.0.0.1:3210"],
  ];
  for (let first = 0; first < selectors.length; first++) {
    for (let second = first + 1; second < selectors.length; second++) {
      let invoked = false;
      const command = new Command("selection-test")
        .addDeploymentSelectionOptions(actionDescription("Inspect"))
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .action(() => {
          invoked = true;
        });
      expect(() =>
        command.parse([...selectors[first], ...selectors[second]], {
          from: "user",
        }),
      ).toThrow(CommanderError);
      expect(invoked).toBe(false);
    }
  }
});
