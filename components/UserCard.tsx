import axios from 'axios'

const fetchPosts = () => axios.get('/api/posts')
const deleteUser2 = (id: string) => axios.delete(`/api/users/${id}`)
const remove = (id: string) =>
  fetch(`/api/users/${id}`, { method: 'DELETE' })

const load = (id: string) =>
  fetch(`/api/user/${id}`)

const create = () =>
  fetch('/api/posts', { method: 'POST' })
