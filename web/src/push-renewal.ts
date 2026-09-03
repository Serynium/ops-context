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

const withStore = async <A>(
  mode: IDBTransactionMode,
  message: string,
  run: (store: IDBObjectStore, done: (value: A) => void) => void
): Promise<A> => {
  const database = await openDatabase()
  try {
    return await new Promise<A>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode)
      let result: A
      run(transaction.objectStore(STORE_NAME), (value) => { result = value })
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error(message))
      transaction.onabort = () => reject(transaction.error ?? new Error(message))
    })
  } finally {
    database.close()
  }
}

const randomEnrollmentKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `ops_enroll_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`
}

export const beginPushEnrollment = async (force: boolean): Promise<string | undefined> => {
  return withStore("readwrite", "could not store push credential", (store, done) => {
    const request = store.get(RECORD_KEY)
    request.onsuccess = () => {
      const current = request.result as PushRenewalCredential | undefined
      if (!force && current?.pending && current.explicit === true) return done(undefined)
      if (current?.enrollment_key && current.pending && current.explicit === force) {
        return done(current.enrollment_key)
      }
      if (current?.enrollment_key && !force && !current.pending) return done(current.enrollment_key)
      const enrollmentKey = randomEnrollmentKey()
      store.put({ ...current, enrollment_key: enrollmentKey, pending: true, explicit: force }, RECORD_KEY)
      done(enrollmentKey)
    }
  })
}

export const completePushEnrollment = async (
  enrollmentKey: string,
  value: Omit<PushRenewalCredential, "enrollment_key" | "pending" | "revoked">
): Promise<void> => {
  await withStore("readwrite", "could not complete push enrollment", (store, done) => {
    const request = store.get(RECORD_KEY)
    request.onsuccess = () => {
      const current = request.result as PushRenewalCredential | undefined
      if (current?.enrollment_key === enrollmentKey && current.pending === true) {
        store.put({ ...value, enrollment_key: enrollmentKey }, RECORD_KEY)
      }
      done(undefined)
    }
  })
}

export const readPushRenewalCredential = (): Promise<PushRenewalCredential | undefined> =>
  withStore("readonly", "could not read push credential", (store, done) => {
    const request = store.get(RECORD_KEY)
    request.onsuccess = () => done(request.result as PushRenewalCredential | undefined)
  })

export const revokePushRenewalCredential = async (
  installationId: string,
  expectedCredential: string | undefined
): Promise<void> => {
  if (!expectedCredential) return
  await withStore("readwrite", "could not clear push credential", (store, done) => {
    const request = store.get(RECORD_KEY)
    request.onsuccess = () => {
      const current = request.result as PushRenewalCredential | undefined
      if (current?.installation_id === installationId && current.credential === expectedCredential) {
        store.put({ installation_id: installationId, revoked: true }, RECORD_KEY)
      }
      done(undefined)
    }
  })
}

export const markPushEnrollmentRevoked = async (enrollmentKey: string): Promise<void> => {
  await withStore("readwrite", "could not mark push enrollment revoked", (store, done) => {
    const request = store.get(RECORD_KEY)
    request.onsuccess = () => {
      const current = request.result as PushRenewalCredential | undefined
      if (current?.enrollment_key === enrollmentKey && current.pending && current.explicit !== true) {
        store.put({ revoked: true }, RECORD_KEY)
      }
      done(undefined)
    }
  })
}
