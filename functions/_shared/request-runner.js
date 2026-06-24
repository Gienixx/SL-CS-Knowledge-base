export async function runJsonRequest(requestUrl, requestOptions) {
  const response = await fetch(requestUrl, requestOptions)
  const responseText = await response.text()

  if (!response.ok) {
    throw new Error(
      `Request failed with status ${response.status}: ${responseText}`
    )
  }

  return responseText
}
