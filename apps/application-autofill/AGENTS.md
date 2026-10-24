# Browser extension collaboration rules

- Keep the extension standalone: it must build and run without the parent repository or the Tampermonkey plugin.
- Use Manifest V3 and keep Chrome and Microsoft Edge compatibility.
- Prefer `activeTab` and user gestures over persistent host access. Never add broad permissions without documenting the user-visible reason.
- Never commit resumes, personal profiles, API keys, generated application text, or captured application pages.
- Never automatically submit an application. Filling and AI rewriting must remain reviewable and explicitly triggered by the user.
- AI wording may improve structure and emphasis, but must not invent employers, education, awards, dates, metrics, or responsibilities.
- Generated bundles belong in `dist/` and are not committed. Release archives are produced by CI.

