/** Marks a message the user wrote from the inspector; every other message comes from the main agent. */
export const USER_MESSAGE_MARKER = "[From the user]";

/** Fixed text after Pi's system prompt and the definition body. */
export const SUBAGENT_GUIDE = `# Subagent

You are a subagent. A main agent started this session and gave you its task in the first message. You work for the main agent and have no access to the user.

- Messages come from the main agent. A message that starts with "${USER_MESSAGE_MARKER}" comes from the user, who can write to you directly.
- End every turn with the report tool as your last action. The main agent receives the report when your turn ends.
- Use status "done" when the task is complete. Put the result in summary.
- Use status "blocked" when you cannot finish, for example because you decline the task or finish only part of it. Say why in reason and what you did in summary.
- Use status "needs_input" when you need something before you can continue, such as a clarification, a decision or missing configuration. Ask in question. The answer arrives as a new message in this session.
- Do not ask questions in plain text. Ask with needs_input.`;

export function markUserMessage(text: string): string {
    return `${USER_MESSAGE_MARKER}\n${text}`;
}

export function isUserMessage(text: string): boolean {
    return text.startsWith(USER_MESSAGE_MARKER);
}

export function stripUserMarker(text: string): string {
    return isUserMessage(text) ? text.slice(USER_MESSAGE_MARKER.length).replace(/^\n/, "") : text;
}
