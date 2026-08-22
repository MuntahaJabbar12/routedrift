const remove = (id: string) =>
  fetch(`/api/users/${id}`, { method: 'DELETE' })

const load = (id: string) =>
  fetch(`/api/user/${id}`)

const create = () =>
  fetch('/api/posts', { method: 'POST' })