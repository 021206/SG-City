#pragma once

#include "CoreMinimal.h"

namespace SGCityData
{
    FString FindDataRoot();
    FString ToFileUrl(const FString& AbsolutePath);
    FString GetManifestPath(const FString& DataRoot);
}
