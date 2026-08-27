// Three bugs are planted in this fixture app. None of them is detectable by
// TypeScript, ESLint or a passing test suite.
//
//   1. `load` calls /api/user/:id — the backend folder is `users`, not `user`.
//      This is the folder-rename bug from the project brief.
//   2. `create` POSTs to /api/posts, which only exports GET. Right path, wrong verb.
//   3. app/api/legacy/export/route.ts is never called from anywhere. Dead route.

const remove = (id: string) =>
  fetch(`/api/users/${id}`, { method: 'DELETE' })

const load = (id: string) =>
  fetch(`/api/user/${id}`)

const create = () =>
  fetch('/api/posts', { method: 'POST' })

export { remove, load, create }
