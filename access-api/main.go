package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg := LoadConfig()
	ctx := context.Background()

	store, err := NewRedisStore(ctx, cfg)
	if err != nil {
		log.Fatalf("failed to connect to redis: %v", err)
	}
	defer store.Close()

	app := NewApp(cfg, store)

	router := gin.Default()
	router.GET("/ping", app.Ping)
	router.GET("/healthz", app.Healthz)
	router.GET("/metrics", app.Metrics)

	api := router.Group("/api/access")
	api.POST("/swipe", app.Swipe)
	api.GET("/state/:employeeId", app.GetState)
	api.POST("/reset/:employeeId", app.ResetState)
	api.GET("/events", app.ListEvents)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Starting Access API on :%s...", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("failed to start server: %v", err)
	}
}
