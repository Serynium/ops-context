import { ApiError, api } from "../api"
import {
  beginPushEnrollment,
  completePushEnrollment,
  markPushEnrollmentRevoked,
  readPushRenewalCredential,
} from "../push-renewal"

const urlBase64ToBytes = (value: string): ArrayBuffer => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer
}
export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
const defaultDeviceName = () =>
  `${(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "Device"} PWA`
export const enablePush = async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    throw new Error("This browser does not support Web Push")
  if (/iPhone|iPad|iPod/u.test(navigator.userAgent) && !isStandalone())
    throw new Error("On iPhone or iPad, install this PWA to the Home Screen before enabling push")
  const registration = await navigator.serviceWorker.ready
  const { public_key } = await api.publicKey()
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notification permission was not granted")
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(public_key),
    }))
  const enrollmentKey = await beginPushEnrollment(true)
  if (!enrollmentKey) throw new Error("Push enrollment could not be started")
  const enrollment = await api.registerPush(defaultDeviceName(), enrollmentKey, subscription.toJSON(), true)
  await completePushEnrollment(enrollmentKey, {
    installation_id: enrollment.subscription.id,
    credential: enrollment.renewal_credential,
  })
}
export const provisionExistingPushCredential = async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  const current = await readPushRenewalCredential()
  if (!subscription || current?.credential || current?.revoked) return
  const enrollmentKey = await beginPushEnrollment(false)
  if (!enrollmentKey) return
  try {
    const enrollment = await api.registerPush(defaultDeviceName(), enrollmentKey, subscription.toJSON(), false)
    await completePushEnrollment(enrollmentKey, {
      installation_id: enrollment.subscription.id,
      credential: enrollment.renewal_credential,
    })
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      (cause.code === "subscription_disabled" || cause.code === "subscription_enrollment_superseded")
    )
      return void (await markPushEnrollmentRevoked(enrollmentKey))
    throw cause
  }
}
