// Correct call sites. Their job in this fixture is to prove the tool stays quiet
// when the frontend and backend agree — a checker that only ever finds problems
// is indistinguishable from one that is broken.

export async function loadUser(id: string) {
  const response = await fetch(`/api/users/${id}`)
  return response.json()
}

export async function loadPosts() {
  const response = await fetch('/api/posts')
  return response.json()
}
