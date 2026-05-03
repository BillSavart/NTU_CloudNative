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
}

type AccessDecision struct {
	Granted       bool
	Reason        string
	PreviousState string
	CurrentState  string
}

type AccessEvent struct {
	RequestID     string
	EmployeeID    string
	GateID        string
	Direction     string
	Decision      string
	Reason        string
	PreviousState string
	CurrentState  string
	LatencyMs     int64
	Timestamp     time.Time
}

type EventDTO struct {
	ID     string            `json:"id"`
	Fields map[string]string `json:"fields"`
}
