/**
 * The minimum an agent must expose for the router to know when NOT to classify.
 *
 * This exists to preserve a rule established in Phase 2: a user replying "yes"
 * to a delete confirmation sends an ordinary message, and classifying it
 * returns `unrelated` — which would strand the pending action and silently
 * break every destructive-action confirmation.
 *
 * Rather than move that state into the router, agents keep owning their own
 * conversations and simply answer whether they are waiting on a reply. The
 * router asks first, and dispatches straight there when the answer is yes.
 */
export abstract class FollowUpCapableAgent {
  /** True when this agent is awaiting the tenant's next message. */
  abstract claimsFollowUp(tenantId: string, now?: Date): Promise<boolean>;
}
