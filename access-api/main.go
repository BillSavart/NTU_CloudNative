package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg := LoadConfig()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	shutdownTracing := SetupTracing(ctx, cfg)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			log.Printf("trace provider shutdown failed: %v", err)
		}
	}()

	store, err := NewRedisStore(ctx, cfg)
	if err != nil {
		log.Fatalf("failed to connect to redis: %v", err)
	}
	defer store.Close()

	publisher := NewEventPublisher(cfg, store)
	defer publisher.Close()

	app := NewApp(cfg, store, publisher)

	router := gin.Default()
	router.Use(TracingMiddleware(cfg))
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
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("failed to start server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("Shutting down Access API...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown failed: %v", err)
	}
}
