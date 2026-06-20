export async function onRequestPost() {
  return new Response(JSON.stringify({
    error: 'This endpoint is reserved for the first-login setup flow.'
  }), {
    status: 501,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  })
}
