export interface PushRenewalCredential {
  readonly installation_id: string
  readonly credential: string
}

const DATABASE_NAME = "ops-context-pwa"
const STORE_NAME = "credentials"
const RECORD_KEY = "push-renewal"

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("could not open push credential storage"))
  })

export const storePushRenewalCredential = async (value: PushRenewalCredential): Promise<void> => {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      transaction.objectStore(STORE_NAME).put(value, RECORD_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("could not store push credential"))
      transaction.onabort = () => reject(transaction.error ?? new Error("push credential storage was aborted"))
    })
  } finally {
    database.close()
  }
}

export const readPushRenewalCredential = async (): Promise<PushRenewalCredential | undefined> => {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(RECORD_KEY)
      request.onsuccess = () => resolve(request.result as PushRenewalCredential | undefined)
      request.onerror = () => reject(request.error ?? new Error("could not read push credential"))
    })
  } finally {
    database.close()
  }
}

export const clearPushRenewalCredential = async (installationId: string): Promise<void> => {
  const current = await readPushRenewalCredential()
  if (current?.installation_id !== installationId) return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      transaction.objectStore(STORE_NAME).delete(RECORD_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("could not clear push credential"))
    })
  } finally {
    database.close()
  }
}
