package main

import "time"

const (
	DirectionIn  = "IN"
	DirectionOut = "OUT"

	DecisionGranted = "GRANTED"
	DecisionDenied  = "DENIED"

	ReasonAccessAllowed         = "ACCESS_ALLOWED"
	ReasonAntiPassbackViolation = "ANTI_PASSBACK_VIOLATION"
	ReasonNoEntryRecord         = "NO_ENTRY_RECORD"
	ReasonInvalidDirection      = "INVALID_DIRECTION"
)

type SwipeRequest struct {
	EmployeeID string `json:"employeeId" binding:"required"`
	GateID     string `json:"gateId" binding:"required"`
	Direction  string `json:"direction" binding:"required"`
}

type SwipeResponse struct {
	RequestID     string `json:"requestId"`
	Decision      string `json:"decision"`
	Reason        string `json:"reason"`
	EmployeeID    string `json:"employeeId"`
	GateID        string `json:"gateId"`
	Direction     string `json:"direction"`
	PreviousState string `json:"previousState"`
	CurrentState  string `json:"currentState"`
	LatencyMs     int64  `json:"latencyMs"`
	Timestamp     string `json:"timestamp"`
	EventBuffered bool   `json:"eventBuffered"`
	KafkaQueued   bool   `json:"kafkaQueued"`
}

type AccessDecision struct {
	Granted       bool
	Reason        string
	PreviousState string
	CurrentState  string
}

type AccessEvent struct {
	RequestID     string    `json:"requestId"`
	EmployeeID    string    `json:"employeeId"`
	GateID        string    `json:"gateId"`
	Direction     string    `json:"direction"`
	Decision      string    `json:"decision"`
	Reason        string    `json:"reason"`
	PreviousState string    `json:"previousState"`
	CurrentState  string    `json:"currentState"`
	LatencyMs     int64     `json:"latencyMs"`
	Timestamp     time.Time `json:"timestamp"`
	TraceParent   string    `json:"traceparent,omitempty"`
	TraceState    string    `json:"tracestate,omitempty"`
}

type EventDTO struct {
	ID     string            `json:"id"`
	Fields map[string]string `json:"fields"`
}
