# ReplyMind Backend

Node/Express API server for **ReplyMind** — the AI Gmail-reply extension.
Handles auth, JWT sessions, and reply-generation requests from the browser
extension.

## Stack

Express + JWT auth + bcrypt password hashing. See `package.json` for the
full dependency list.

## Structure

```
routes/
  auth.js       login / signup / session
  generate.js   AI reply generation endpoint
middleware/     auth guards
db/             data layer
admin/          admin utilities
server.js       entry point
```

## Run locally

```bash
npm install
cp .env.example .env      # fill in your keys
npm run dev                # nodemon server.js
```

## Related

- Frontend/extension + landing page: [replymind](https://github.com/harelos/replymind)

---

Built by [Zvi](https://github.com/harelos).
