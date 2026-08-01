## ADDED Requirements

### Requirement: DeepSeek model family support
The system SHALL recognize DeepSeek as a first-class model family with explicit capability mapping.

#### Scenario: DeepSeek models resolve family-specific context windows
- **GIVEN** a model id that belongs to the DeepSeek family
- **WHEN** the runtime resolves context budget metadata
- **THEN** it SHALL use DeepSeek-specific context window rules instead of the generic fallback
- **AND** SHALL distinguish modern DeepSeek variants from legacy ones when model ids provide that signal.

#### Scenario: DeepSeek aliases preserve model selection compatibility
- **GIVEN** a persisted model selection or provider configuration that references a DeepSeek alias
- **WHEN** the UI or runtime loads that selection
- **THEN** it SHALL resolve to a valid DeepSeek-capable provider/model entry when available
- **AND** SHALL keep existing non-DeepSeek selections unchanged.

### Requirement: Cache-aware prompt serialization
The system SHALL keep the immutable prompt prefix as stable as possible for cache-friendly DeepSeek requests.

#### Scenario: Stable prefix remains deterministic across turns
- **GIVEN** the same system prompt and tool set
- **WHEN** two consecutive LLM requests are serialized
- **THEN** the immutable prefix portion SHALL preserve deterministic ordering and formatting
- **AND** SHALL avoid unnecessary byte-level drift in unchanged sections.

#### Scenario: Structured prompt parts preserve source ranges
- **GIVEN** the composer builds structured prompt parts from the input buffer
- **WHEN** the prompt is normalized for submission
- **THEN** the source ranges and part ordering SHALL remain stable enough to reproduce the same serialized prompt layout when the user input is unchanged.

### Requirement: Model-aware context budgeting
The system SHALL use model-specific context budgeting and compaction thresholds for DeepSeek requests.

#### Scenario: DeepSeek compaction uses model-aware thresholds
- **GIVEN** a DeepSeek model with a known context window
- **WHEN** the runtime decides whether to compact history
- **THEN** it SHALL use a threshold derived from that model's window rather than the generic fallback.

#### Scenario: DeepSeek prompt growth preserves cache economics
- **GIVEN** a DeepSeek session with repeated turns and stable tool definitions
- **WHEN** the request grows over time
- **THEN** the runtime SHALL favor late compaction and stable prefix preservation over eager rewriting.

### Requirement: Existing provider flows remain compatible
The system SHALL preserve existing provider selection and runtime behavior for non-DeepSeek models.

#### Scenario: Non-DeepSeek providers keep current behavior
- **GIVEN** a model outside the DeepSeek family
- **WHEN** the user selects that model
- **THEN** the system SHALL keep the current provider flow intact
- **AND** SHALL not require DeepSeek-specific request annotations.

