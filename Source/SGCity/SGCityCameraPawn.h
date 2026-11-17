#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "SGCityCameraPawn.generated.h"

class UCameraComponent;
class USpringArmComponent;

UCLASS()
class SGCITY_API ASGCityCameraPawn : public APawn
{
    GENERATED_BODY()

public:
    ASGCityCameraPawn();
    virtual void Tick(float DeltaSeconds) override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

protected:
    UPROPERTY(VisibleAnywhere, Category = "Camera")
    TObjectPtr<USceneComponent> SceneRoot;

    UPROPERTY(VisibleAnywhere, Category = "Camera")
    TObjectPtr<USpringArmComponent> SpringArm;

    UPROPERTY(VisibleAnywhere, Category = "Camera")
    TObjectPtr<UCameraComponent> Camera;

private:
    void OnMoveForward(float Value) { MoveForwardInput = Value; }
    void OnMoveRight(float Value) { MoveRightInput = Value; }
    void OnOrbitYaw(float Value) { OrbitYawInput = Value; }
    void OnOrbitPitch(float Value) { OrbitPitchInput = Value; }
    void OnPanX(float Value) { PanXInput = Value; }
    void OnPanY(float Value) { PanYInput = Value; }
    void OnZoom(float Value) { ZoomInput = Value; }

    float MoveForwardInput = 0.0f;
    float MoveRightInput = 0.0f;
    float OrbitYawInput = 0.0f;
    float OrbitPitchInput = 0.0f;
    float PanXInput = 0.0f;
    float PanYInput = 0.0f;
    float ZoomInput = 0.0f;
    float DesiredArmLength = 300000.0f;
};
