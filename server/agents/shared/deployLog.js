'use strict';

// Helpers for reasoning about the deployment operation log (the array of
// { action, resource_state, error? } entries appended by the aws agent's tools).

// Verbs that bring a resource into existence (vs describe/list/tag/delete).
export const CREATE_RE = /\b(create-|run-instances|run-task|provision-|register-|allocate-address)/i;

// The creation commands that SUCCEEDED — the only resources that could actually
// exist in AWS. Used to (a) tell the teardown agent exactly what to delete
// (ignoring failed/never-created resources and describe noise), and (b) decide
// whether there is anything to tear down at all.
export function successfulCreations(log) {
    return (Array.isArray(log) ? log : []).filter(
        (op) => op && !op.error && CREATE_RE.test(String(op.action))
    );
}
