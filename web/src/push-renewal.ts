export interface PushRenewalCredential {
  readonly installation_id?: string
  readonly credential?: string
  readonly enrollment_key?: string
  readonly pending?: boolean
  readonly explicit?: boolean
  readonly revoked?: boolean
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

const randomEnrollmentKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `ops_enroll_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`
}

export const beginPushEnrollment = async (force: boolean): Promise<string | undefined> => {
  const database = await openDatabase()
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(RECORD_KEY)
      let enrollmentKey: string | undefined
      request.onsuccess = () => {
        const current = request.result as PushRenewalCredential | undefined
        if (!force && current?.pending && current.explicit === true) return
        if (
          current?.enrollment_key &&
          current.pending &&
          current.explicit === force
        ) {
          enrollmentKey = current.enrollment_key
          return
        }
        if (current?.enrollment_key && !force && !current.pending) {
          enrollmentKey = current.enrollment_key
          return
        }
        enrollmentKey = randomEnrollmentKey()
        store.put({ ...current, enrollment_key: enrollmentKey, pending: true, explicit: force }, RECORD_KEY)
      }
      transaction.oncomplete = () => resolve(enrollmentKey)
      transaction.onerror = () => reject(transaction.error ?? new Error("could not store push credential"))
      transaction.onabort = () => reject(transaction.error ?? new Error("push credential storage was aborted"))
    })
  } finally {
    database.close()
  }
}

export const completePushEnrollment = async (
  enrollmentKey: string,
  value: Omit<PushRenewalCredential, "enrollment_key" | "pending" | "revoked">
): Promise<void> => {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(RECORD_KEY)
      request.onsuccess = () => {
        const current = request.result as PushRenewalCredential | undefined
        if (current?.enrollment_key === enrollmentKey && current.pending === true) {
          store.put({ ...value, enrollment_key: enrollmentKey }, RECORD_KEY)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("could not complete push enrollment"))
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

export const revokePushRenewalCredential = async (
  installationId: string,
  expectedCredential: string | undefined
): Promise<void> => {
  if (!expectedCredential) return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(RECORD_KEY)
      request.onsuccess = () => {
        const current = request.result as PushRenewalCredential | undefined
        if (current?.installation_id === installationId && current.credential === expectedCredential) {
          store.put({ installation_id: installationId, revoked: true }, RECORD_KEY)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("could not clear push credential"))
    })
  } finally {
    database.close()
  }
}

export const markPushEnrollmentRevoked = async (enrollmentKey: string): Promise<void> => {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(RECORD_KEY)
      request.onsuccess = () => {
        const current = request.result as PushRenewalCredential | undefined
        if (
          current?.enrollment_key === enrollmentKey &&
          current.pending &&
          current.explicit !== true
        ) {
          store.put({ revoked: true }, RECORD_KEY)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("could not mark push enrollment revoked"))
    })
  } finally {
    database.close()
  }
}
