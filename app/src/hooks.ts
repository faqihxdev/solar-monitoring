import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { api } from "./api";
import { todayJkt } from "./format";

const SUMMARY_REFETCH_MS = 5_000;
const TREND_REFETCH_MS = 60_000;

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: api.config,
    staleTime: 5 * 60 * 1000,
  });
}

export function useThresholds() {
  return useQuery({
    queryKey: ["thresholds"],
    queryFn: api.thresholds,
    staleTime: 10 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}

export function useControlAudit() {
  return useQuery({
    queryKey: ["control-audit"],
    queryFn: api.controlAudit,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useControls() {
  return useQuery({
    queryKey: ["controls"],
    queryFn: api.controls,
    refetchInterval: 60_000,
  });
}

export function useControlLog() {
  return useQuery({
    queryKey: ["control-log"],
    queryFn: () => api.controlLog(80),
    refetchInterval: 30_000,
  });
}

export function useAutomation() {
  return useQuery({
    queryKey: ["automation"],
    queryFn: api.automation,
    refetchInterval: 30_000,
  });
}

export function useControlMutations() {
  const queryClient = useQueryClient();
  const invalidateControls = () => {
    void queryClient.invalidateQueries({ queryKey: ["controls"] });
    void queryClient.invalidateQueries({ queryKey: ["control-audit"] });
    void queryClient.invalidateQueries({ queryKey: ["control-log"] });
    void queryClient.invalidateQueries({ queryKey: ["thresholds"] });
    void queryClient.invalidateQueries({ queryKey: ["automation"] });
  };

  return {
    readAll: useMutation({
      mutationFn: api.readAllControls,
      onSuccess: invalidateControls,
    }),
    readOne: useMutation({
      mutationFn: api.readControl,
      onSuccess: invalidateControls,
    }),
    write: useMutation({
      mutationFn: ({ id, value, reason }: { id: string; value: string; reason: string }) =>
        api.writeControl(id, value, reason),
      onSuccess: invalidateControls,
    }),
    a6Test: useMutation({
      mutationFn: api.runA6Test,
      onSuccess: invalidateControls,
    }),
    updateAutomation: useMutation({
      mutationFn: api.updateAutomation,
      onSuccess: invalidateControls,
    }),
    evaluateAutomation: useMutation({
      mutationFn: api.evaluateAutomation,
      onSuccess: invalidateControls,
    }),
  };
}

export function useSummary() {
  return useQuery({
    queryKey: ["summary"],
    queryFn: api.summary,
    refetchInterval: SUMMARY_REFETCH_MS,
  });
}

export function useHistory(hours: number) {
  return useQuery({
    queryKey: ["history", hours],
    queryFn: () => api.history(hours),
    refetchInterval: TREND_REFETCH_MS,
  });
}

export function useVoltage(hours: number) {
  return useQuery({
    queryKey: ["voltage", hours],
    queryFn: () => api.voltage(hours),
    refetchInterval: TREND_REFETCH_MS,
  });
}

export function useDailyEnergy(date: string, days = 7) {
  const isToday = date === todayJkt();
  return useQuery({
    queryKey: ["daily", date, days],
    queryFn: () => api.daily(date, days),
    placeholderData: keepPreviousData,
    refetchInterval: isToday ? 5 * 60 * 1000 : false,
    staleTime: isToday ? 4 * 60 * 1000 : 24 * 60 * 60 * 1000,
  });
}
