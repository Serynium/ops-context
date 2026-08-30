import { Schema } from "effect"
import { Level } from "./api-models.js"

const NonEmptyText = (description: string) =>
  Schema.NonEmptyString.annotate({ description })

const Limit = Schema.Int
  .check(Schema.isGreaterThanOrEqualTo(1))
  .check(Schema.isLessThanOrEqualTo(100))
  .annotate({
    description: "Number of results to return, from 1 to 100. Defaults to 25."
  })

const EventSearch = Schema.NonEmptyString
  .check(Schema.isMaxLength(240, { message: "Search query must be at most 240 characters" }))
  .check(Schema.isPattern(/^[^\u0000]*$/u, { message: "Search query must not contain NUL characters" }))
  .annotate({ description: "Case-insensitive token, phrase, or explicit-prefix event search" })

const CommonEventFilterFields = {
  project: Schema.optional(NonEmptyText("Project id or slug")),
  level: Schema.optional(Level),
  source: Schema.optional(NonEmptyText("Exact event source")),
  fingerprint: Schema.optional(NonEmptyText("Exact event fingerprint")),
  since: Schema.optional(NonEmptyText("RFC 3339 lower time bound")),
  until: Schema.optional(NonEmptyText("RFC 3339 upper time bound")),
  grouped: Schema.optional(Schema.Boolean),
  silenced: Schema.optional(Schema.Boolean),
  before: Schema.optional(NonEmptyText("Cursor returned by a previous call")),
  limit: Schema.optional(Limit)
} as const

export const ListProjectsArgumentsSchema = Schema.Struct({})
export const ListEventsArgumentsSchema = Schema.Struct(CommonEventFilterFields)
export const SearchEventsArgumentsSchema = Schema.Struct({
  query: EventSearch,
  ...CommonEventFilterFields
})
export const GetEventArgumentsSchema = Schema.Struct({
  id: NonEmptyText("Event id")
})
export const GetEventGroupArgumentsSchema = Schema.Struct({
  project: NonEmptyText("Project id or slug"),
  fingerprint: NonEmptyText("Fingerprint shared by the occurrences"),
  since: Schema.optional(NonEmptyText("RFC 3339 lower time bound")),
  until: Schema.optional(NonEmptyText("RFC 3339 upper time bound")),
  before: Schema.optional(NonEmptyText("Cursor returned by a previous call")),
  limit: Schema.optional(Limit)
})

// The official MCP SDK accepts Standard Schema implementations. Effect Schema
// provides both validation and JSON Schema conversion, so tool contracts stay
// in the same schema system as the HTTP API.
export const ListProjectsArguments = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(ListProjectsArgumentsSchema)
)
export const ListEventsArguments = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(ListEventsArgumentsSchema)
)
export const SearchEventsArguments = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(SearchEventsArgumentsSchema)
)
export const GetEventArguments = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(GetEventArgumentsSchema)
)
export const GetEventGroupArguments = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(GetEventGroupArgumentsSchema)
)

export interface EventFilterArguments {
  readonly level?: typeof Level.Type | undefined
  readonly source?: string | undefined
  readonly fingerprint?: string | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
  readonly grouped?: boolean | undefined
  readonly silenced?: boolean | undefined
  readonly before?: string | undefined
  readonly limit?: number | undefined
}
