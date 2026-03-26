package main

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

func main() {
	// 建立一個預設的 Gin 路由引擎
	r := gin.Default()

	// 定義基本的健康檢查路由
	r.GET("/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message": "pong",
			"status":  "Access API is running",
		})
	})

	log.Println("Starting Access API on :8080...")
	
	// 啟動伺服器於 0.0.0.0:8080
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
