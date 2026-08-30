export interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
}

interface TaggedFailure<Tag extends string> {
  readonly _tag: Tag
  readonly message: string
}

export interface InvalidEvent extends TaggedFailure<"InvalidEvent"> {
  readonly issues?: ReadonlyArray<ValidationIssue>
}
export interface InvalidProject extends TaggedFailure<"InvalidProject"> {}
export interface InvalidSubscription extends TaggedFailure<"InvalidSubscription"> {}
export interface SubscriptionDisabled extends TaggedFailure<"SubscriptionDisabled"> {}
export interface SubscriptionEnrollmentSuperseded extends TaggedFailure<"SubscriptionEnrollmentSuperseded"> {}
export interface InvalidRenewalCredential extends TaggedFailure<"InvalidRenewalCredential"> {}
export interface SubscriptionRevoked extends TaggedFailure<"SubscriptionRevoked"> {}
export interface SubscriptionEndpointConflict extends TaggedFailure<"SubscriptionEndpointConflict"> {}
export interface InvalidSilence extends TaggedFailure<"InvalidSilence"> {}
export interface InvalidSettings extends TaggedFailure<"InvalidSettings"> {}
export interface InvalidEventQuery extends TaggedFailure<"InvalidEventQuery"> {}
export interface ProjectNotFound extends TaggedFailure<"ProjectNotFound"> {}
export interface EventNotFound extends TaggedFailure<"EventNotFound"> {}
export interface SubscriptionNotFound extends TaggedFailure<"SubscriptionNotFound"> {}
export interface SilenceNotFound extends TaggedFailure<"SilenceNotFound"> {}
export interface InvalidProjectCredential extends TaggedFailure<"InvalidProjectCredential"> {}
export interface DuplicateExternalId extends TaggedFailure<"DuplicateExternalId"> {}
export interface ProjectDeletionConflict extends TaggedFailure<"ProjectDeletionConflict"> {}
export interface PushNotConfigured extends TaggedFailure<"PushNotConfigured"> {}
export interface RepositoryUnavailable extends TaggedFailure<"RepositoryUnavailable"> {
  readonly cause?: unknown
}
export interface QueueUnavailable extends TaggedFailure<"QueueUnavailable"> {
  readonly cause?: unknown
}
export interface CryptographyUnavailable extends TaggedFailure<"CryptographyUnavailable"> {
  readonly cause?: unknown
}
export interface DeliveryTemporarilyUnavailable extends TaggedFailure<"DeliveryTemporarilyUnavailable"> {
  readonly cause?: unknown
}

export type InfrastructureError = RepositoryUnavailable | QueueUnavailable |
  CryptographyUnavailable | DeliveryTemporarilyUnavailable

export type DomainError = InvalidEvent | InvalidProject | InvalidSubscription |
  SubscriptionDisabled | SubscriptionEnrollmentSuperseded | InvalidRenewalCredential |
  SubscriptionRevoked | SubscriptionEndpointConflict |
  InvalidSilence | InvalidSettings | InvalidEventQuery | ProjectNotFound |
  EventNotFound | SubscriptionNotFound | SilenceNotFound |
  InvalidProjectCredential | DuplicateExternalId | ProjectDeletionConflict | PushNotConfigured

export type ApplicationError = DomainError | InfrastructureError

export const invalidEvent = (message: string, issues?: ReadonlyArray<ValidationIssue>): InvalidEvent =>
  ({ _tag: "InvalidEvent", message, ...(issues ? { issues } : {}) })
export const invalidProject = (message: string): InvalidProject => ({ _tag: "InvalidProject", message })
export const invalidSubscription = (message: string): InvalidSubscription => ({ _tag: "InvalidSubscription", message })
export const subscriptionDisabled = (message = "this push installation is disabled and requires explicit re-enrollment"): SubscriptionDisabled =>
  ({ _tag: "SubscriptionDisabled", message })
export const subscriptionEnrollmentSuperseded = (message = "explicit push enrollment superseded this silent enrollment"): SubscriptionEnrollmentSuperseded =>
  ({ _tag: "SubscriptionEnrollmentSuperseded", message })
export const invalidRenewalCredential = (message = "invalid push renewal credential"): InvalidRenewalCredential =>
  ({ _tag: "InvalidRenewalCredential", message })
export const subscriptionRevoked = (message = "this push installation has been disabled or removed"): SubscriptionRevoked =>
  ({ _tag: "SubscriptionRevoked", message })
export const subscriptionEndpointConflict = (message = "push endpoint belongs to another installation"): SubscriptionEndpointConflict =>
  ({ _tag: "SubscriptionEndpointConflict", message })
export const invalidSilence = (message: string): InvalidSilence => ({ _tag: "InvalidSilence", message })
export const invalidSettings = (message: string): InvalidSettings => ({ _tag: "InvalidSettings", message })
export const invalidEventQuery = (message: string): InvalidEventQuery => ({ _tag: "InvalidEventQuery", message })
export const projectNotFound = (message = "project not found"): ProjectNotFound => ({ _tag: "ProjectNotFound", message })
export const eventNotFound = (message = "event not found"): EventNotFound => ({ _tag: "EventNotFound", message })
export const subscriptionNotFound = (message = "push subscription not found"): SubscriptionNotFound => ({ _tag: "SubscriptionNotFound", message })
export const silenceNotFound = (message = "silence rule not found"): SilenceNotFound => ({ _tag: "SilenceNotFound", message })
export const invalidProjectCredential = (message = "invalid project API key"): InvalidProjectCredential => ({ _tag: "InvalidProjectCredential", message })
export const duplicateExternalId = (message: string): DuplicateExternalId => ({ _tag: "DuplicateExternalId", message })
export const projectDeletionConflict = (message: string): ProjectDeletionConflict => ({ _tag: "ProjectDeletionConflict", message })
export const pushNotConfigured = (message = "Web Push is not configured"): PushNotConfigured => ({ _tag: "PushNotConfigured", message })
export const repositoryUnavailable = (message: string, cause?: unknown): RepositoryUnavailable => ({ _tag: "RepositoryUnavailable", message, cause })
export const queueUnavailable = (message: string, cause?: unknown): QueueUnavailable => ({ _tag: "QueueUnavailable", message, cause })
export const cryptographyUnavailable = (message: string, cause?: unknown): CryptographyUnavailable => ({ _tag: "CryptographyUnavailable", message, cause })
export const deliveryTemporarilyUnavailable = (message: string, cause?: unknown): DeliveryTemporarilyUnavailable => ({ _tag: "DeliveryTemporarilyUnavailable", message, cause })

const applicationErrorTags = new Set<ApplicationError["_tag"]>([
  "InvalidEvent", "InvalidProject", "InvalidSubscription", "InvalidSilence",
  "InvalidSettings", "InvalidEventQuery", "ProjectNotFound", "EventNotFound",
  "SubscriptionDisabled", "SubscriptionEnrollmentSuperseded", "InvalidRenewalCredential",
  "SubscriptionRevoked", "SubscriptionEndpointConflict",
  "SubscriptionNotFound", "SilenceNotFound", "InvalidProjectCredential",
  "DuplicateExternalId", "ProjectDeletionConflict", "PushNotConfigured",
  "RepositoryUnavailable", "QueueUnavailable", "CryptographyUnavailable",
  "DeliveryTemporarilyUnavailable"
])

export const isApplicationError = (value: unknown): value is ApplicationError =>
  typeof value === "object" && value !== null &&
  applicationErrorTags.has((value as { readonly _tag?: ApplicationError["_tag"] })._tag as ApplicationError["_tag"])
