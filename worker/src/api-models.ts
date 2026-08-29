import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"
import type { AppError } from "./errors.js"

export const Level = Schema.Literals(["info", "success", "warning", "error", "critical"])
export type Level = typeof Level.Type

export const SilenceField = Schema.Literals(["fingerprint", "title", "source"])
export type SilenceField = typeof SilenceField.Type

export const JsonObject = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
})

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  icon: Schema.String,
  notify: Schema.Boolean,
  min_level: Level,
  created_at: Schema.String,
  updated_at: Schema.String
})

export const ProjectCreated = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  icon: Schema.String,
  notify: Schema.Boolean,
  min_level: Level,
  created_at: Schema.String,
  updated_at: Schema.String,
  api_key: Schema.String
})

export const Event = Schema.Struct({
  id: Schema.String,
  external_id: Schema.optional(Schema.String),
  project_id: Schema.String,
  project_name: Schema.String,
  project_slug: Schema.String,
  project_icon: Schema.String,
  source: Schema.String,
  type: Schema.String,
  level: Level,
  title: Schema.String,
  body: Schema.String,
  fingerprint: Schema.String,
  data: JsonObject,
  occurred_at: Schema.String,
  created_at: Schema.String,
  silenced: Schema.Boolean,
  silence_id: Schema.optional(Schema.String)
})

export const Delivery = Schema.Struct({
  id: Schema.String,
  event_id: Schema.String,
  subscription_id: Schema.String,
  subscription_name: Schema.String,
  status: Schema.Literals(["sent", "failed", "skipped"]),
  response_status: Schema.NullOr(Schema.Number),
  error: Schema.String,
  attempted_at: Schema.String
})

export const PushSubscription = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  endpoint_host: Schema.String,
  user_agent: Schema.String,
  last_seen_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String
})

export const Silence = Schema.Struct({
  id: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  project_name: Schema.NullOr(Schema.String),
  field: SilenceField,
  value: Schema.String,
  note: Schema.String,
  created_at: Schema.String
})

export const Settings = Schema.Struct({
  retention_days: Schema.Int,
  redact_keys: Schema.Array(Schema.String),
  default_redact_keys: Schema.Array(Schema.String),
  setup_completed: Schema.Boolean
})

export const AuthState = Schema.Struct({
  auth_required: Schema.Boolean,
  authenticated: Schema.Boolean
})

export const AuthStateWithCookie = HttpApiSchema.WithHeaders(AuthState, {
  "set-cookie": Schema.String
})

export const LogoutWithCookie = HttpApiSchema.WithHeaders(
  Schema.Void.pipe(HttpApiSchema.status(204)),
  { "set-cookie": Schema.String }
)

export const Health = Schema.Struct({ status: Schema.String })
export const PushPublicKey = Schema.Struct({ public_key: Schema.String })
export const EventCreated = Schema.Struct({ id: Schema.String, created_at: Schema.String })
export const EventPage = Schema.Struct({
  events: Schema.Array(Event),
  next_cursor: Schema.optional(Schema.String)
})
export const Deliveries = Schema.Struct({ deliveries: Schema.Array(Delivery) })
export const Unsilenced = Schema.Struct({ event: Event, deliveries: Schema.Array(Delivery) })
export const Projects = Schema.Struct({ projects: Schema.Array(Project) })
export const ProjectIcons = Schema.Struct({ icons: Schema.Array(Schema.String) })
export const PushSubscriptions = Schema.Struct({ subscriptions: Schema.Array(PushSubscription) })
export const Silences = Schema.Struct({
  silences: Schema.Array(Silence),
  fields: Schema.Array(SilenceField),
  silenced_events: Schema.Int
})

export const Status = Schema.Struct({
  version: Schema.String,
  server: Schema.String,
  database: Schema.String,
  base_url: Schema.String,
  uptime_seconds: Schema.Null,
  web_push: Schema.Struct({
    configured: Schema.Boolean,
    subject: Schema.String
  }),
  projects: Schema.Int,
  events: Schema.Int,
  subscriptions: Schema.Int,
  enabled_subscriptions: Schema.Int,
  last_push: Schema.NullOr(Delivery),
  retention_days: Schema.Int,
  setup_completed: Schema.Boolean,
  admin_auth: Schema.Boolean
})

export const TestNotificationResult = Schema.Struct({
  event: Event,
  web_push_configured: Schema.Boolean
})

export const AuthLoginInput = Schema.Struct({
  username: Schema.String,
  password: Schema.String
})

export const CreateEventInput = Schema.Struct({
  external_id: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  level: Schema.optional(Level),
  title: Schema.String,
  body: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  occurred_at: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown)
})

export const EventListQuery = Schema.Struct({
  project: Schema.optional(Schema.String),
  level: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  silenced: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String)
})

export const CreateProjectInput = Schema.Struct({
  name: Schema.String,
  icon: Schema.optional(Schema.String)
})

export const UpdateProjectInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  notify: Schema.optional(Schema.Boolean),
  min_level: Schema.optional(Level)
})

export const BrowserPushSubscription = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.optional(Schema.NullOr(Schema.Number)),
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String
  })
})

export const RegisterSubscriptionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  subscription: BrowserPushSubscription
})

export const UpdateSubscriptionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean)
})

export const CreateSilenceInput = Schema.Struct({
  project_id: Schema.optional(Schema.String),
  field: SilenceField,
  value: Schema.String,
  note: Schema.optional(Schema.String)
})

export const UpdateSettingsInput = Schema.Struct({
  retention_days: Schema.optional(Schema.Int),
  redact_keys: Schema.optional(Schema.Array(Schema.String)),
  setup_completed: Schema.optional(Schema.Boolean)
})

export const TestNotificationInput = Schema.Struct({
  project_id: Schema.optional(Schema.String)
})

const errorFields = {
  error: Schema.String,
  message: Schema.String
} as const

export class BadRequestError extends Schema.TaggedError<BadRequestError>()(
  "BadRequestError",
  errorFields,
  { httpApiStatus: 400 }
) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  errorFields,
  { httpApiStatus: 401 }
) {}

export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()(
  "ForbiddenError",
  errorFields,
  { httpApiStatus: 403 }
) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFoundError",
  errorFields,
  { httpApiStatus: 404 }
) {}

export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "ConflictError",
  errorFields,
  { httpApiStatus: 409 }
) {}

export class InvalidError extends Schema.TaggedError<InvalidError>()(
  "InvalidError",
  errorFields,
  { httpApiStatus: 422 }
) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  errorFields,
  { httpApiStatus: 500 }
) {}

export class ServiceUnavailableError extends Schema.TaggedError<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  errorFields,
  { httpApiStatus: 503 }
) {}

export type ApiFailure =
  | BadRequestError
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | ConflictError
  | InvalidError
  | InternalError
  | ServiceUnavailableError

export const CommonErrors = [
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidError,
  InternalError,
  ServiceUnavailableError
] as const

export const toApiFailure = (error: AppError): ApiFailure => {
  const fields = { error: error.code, message: error.message }
  switch (error.status) {
    case 400:
      return new BadRequestError(fields)
    case 401:
      return new UnauthorizedError(fields)
    case 403:
      return new ForbiddenError(fields)
    case 404:
      return new NotFoundError(fields)
    case 409:
      return new ConflictError(fields)
    case 422:
      return new InvalidError(fields)
    case 503:
      return new ServiceUnavailableError(fields)
    default:
      return new InternalError({ error: "internal", message: "something went wrong" })
  }
}
