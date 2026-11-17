#include "SGCityCameraPawn.h"

#include "Camera/CameraComponent.h"
#include "Components/InputComponent.h"
#include "Components/SceneComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"

ASGCityCameraPawn::ASGCityCameraPawn()
{
    PrimaryActorTick.bCanEverTick = true;
    AutoPossessPlayer = EAutoReceiveInput::Player0;

    SceneRoot = CreateDefaultSubobject<USceneComponent>(TEXT("SceneRoot"));
    SetRootComponent(SceneRoot);

    SpringArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("SpringArm"));
    SpringArm->SetupAttachment(SceneRoot);
    SpringArm->TargetArmLength = DesiredArmLength;
    SpringArm->SetRelativeRotation(FRotator(-50.0, 0.0, 0.0));
    SpringArm->bDoCollisionTest = false;
    SpringArm->bUsePawnControlRotation = false;

    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    Camera->SetupAttachment(SpringArm, USpringArmComponent::SocketName);
    Camera->FieldOfView = 55.0f;
}

void ASGCityCameraPawn::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);

    const APlayerController* PlayerController = Cast<APlayerController>(GetController());
    if (!PlayerController)
    {
        return;
    }

    const FRotator YawRotation(0.0, GetActorRotation().Yaw, 0.0);
    const FVector Forward = FRotationMatrix(YawRotation).GetUnitAxis(EAxis::X);
    const FVector Right = FRotationMatrix(YawRotation).GetUnitAxis(EAxis::Y);
    const float MoveSpeed = FMath::Clamp(SpringArm->TargetArmLength * 0.8f, 30000.0f, 300000.0f);
    AddActorWorldOffset((Forward * MoveForwardInput + Right * MoveRightInput) * MoveSpeed * DeltaSeconds, true);

    if (PlayerController->IsInputKeyDown(EKeys::RightMouseButton))
    {
        AddActorWorldRotation(FRotator(0.0, OrbitYawInput * 2.0, 0.0));
        const FRotator ArmRotation = SpringArm->GetRelativeRotation();
        SpringArm->SetRelativeRotation(FRotator(
            FMath::Clamp(ArmRotation.Pitch - OrbitPitchInput * 1.5, -85.0, -15.0),
            0.0,
            0.0));
    }

    if (PlayerController->IsInputKeyDown(EKeys::MiddleMouseButton))
    {
        const float PanSpeed = SpringArm->TargetArmLength * 0.0025f;
        AddActorWorldOffset((-Right * PanXInput + Forward * PanYInput) * PanSpeed, true);
    }

    if (!FMath::IsNearlyZero(ZoomInput))
    {
        DesiredArmLength = FMath::Clamp(
            DesiredArmLength * FMath::Pow(1.15f, -ZoomInput),
            30000.0f,
            900000.0f);
    }
    SpringArm->TargetArmLength = FMath::FInterpTo(
        SpringArm->TargetArmLength, DesiredArmLength, DeltaSeconds, 8.0f);
}

void ASGCityCameraPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);

    PlayerInputComponent->BindAxis("MoveForward", this, &ASGCityCameraPawn::OnMoveForward);
    PlayerInputComponent->BindAxis("MoveRight", this, &ASGCityCameraPawn::OnMoveRight);
    PlayerInputComponent->BindAxis("OrbitYaw", this, &ASGCityCameraPawn::OnOrbitYaw);
    PlayerInputComponent->BindAxis("OrbitPitch", this, &ASGCityCameraPawn::OnOrbitPitch);
    PlayerInputComponent->BindAxis("PanX", this, &ASGCityCameraPawn::OnPanX);
    PlayerInputComponent->BindAxis("PanY", this, &ASGCityCameraPawn::OnPanY);
    PlayerInputComponent->BindAxis("Zoom", this, &ASGCityCameraPawn::OnZoom);
}
