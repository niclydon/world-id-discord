import { ApiResponse } from '@/types/discord-integration-api/api-response'
import { NextResponse } from 'next/server'

/** Response envelope the integration API client parses: { success, data? } or { success, error }. */
export const integrationApiSuccess = <T>(data?: T, status = 200) =>
  NextResponse.json({ success: true, data } satisfies ApiResponse<T>, { status })

export const integrationApiError = (error: string, status: number) =>
  NextResponse.json({ success: false, error } satisfies ApiResponse, { status })
