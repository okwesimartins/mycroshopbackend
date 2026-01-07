const { Sequelize } = require('sequelize');
const moment = require('moment');

/**
 * Get comprehensive staff analytics
 */
async function getStaffAnalytics(req, res) {
  try {
    const { staff_id, start_date, end_date, store_id, group_by = 'month' } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    const where = {
      clock_in_time: {
        [Sequelize.Op.between]: [start_date, end_date]
      }
    };

    if (staff_id) where.staff_id = staff_id;
    if (store_id) where.store_id = store_id;

    // Get all attendance records
    const attendanceRecords = await req.db.models.StaffAttendance.findAll({
      where,
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id', 'email', 'phone']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name'],
          required: false
        }
      ],
      order: [['clock_in_time', 'ASC']]
    });

    // Calculate metrics
    const analytics = calculateStaffMetrics(attendanceRecords, start_date, end_date, group_by);

    res.json({
      success: true,
      data: {
        period: { start_date, end_date },
        summary: analytics.summary,
        staff_breakdown: analytics.staffBreakdown,
        trends: analytics.trends,
        comparisons: analytics.comparisons
      }
    });
  } catch (error) {
    console.error('Error getting staff analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get staff analytics'
    });
  }
}

/**
 * Get individual staff member analytics
 */
async function getStaffMemberAnalytics(req, res) {
  try {
    const { staff_id } = req.params;
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    // Get staff info
    const staff = await req.db.models.Staff.findByPk(staff_id, {
      include: [
        {
          model: req.db.models.Role,
          attributes: ['id', 'name'],
          required: false
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name'],
          required: false
        }
      ]
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    // Get attendance records
    const attendanceRecords = await req.db.models.StaffAttendance.findAll({
      where: {
        staff_id,
        clock_in_time: {
          [Sequelize.Op.between]: [start_date, end_date]
        }
      },
      order: [['clock_in_time', 'ASC']]
    });

    // Calculate detailed metrics
    const metrics = calculateIndividualStaffMetrics(attendanceRecords, start_date, end_date);

    res.json({
      success: true,
      data: {
        staff: {
          id: staff.id,
          name: staff.name,
          employee_id: staff.employee_id,
          email: staff.email,
          role: staff.Role ? staff.Role.name : null,
          store: staff.Store ? staff.Store.name : null
        },
        period: { start_date, end_date },
        metrics
      }
    });
  } catch (error) {
    console.error('Error getting staff member analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get staff member analytics'
    });
  }
}

/**
 * Get attendance summary by period
 */
async function getAttendanceSummary(req, res) {
  try {
    const { period = 'month', store_id } = req.query;

    let startDate, endDate;
    const now = moment();

    switch (period) {
      case 'today':
        startDate = now.startOf('day').format('YYYY-MM-DD');
        endDate = now.endOf('day').format('YYYY-MM-DD');
        break;
      case 'week':
        startDate = now.startOf('week').format('YYYY-MM-DD');
        endDate = now.endOf('week').format('YYYY-MM-DD');
        break;
      case 'month':
        startDate = now.startOf('month').format('YYYY-MM-DD');
        endDate = now.endOf('month').format('YYYY-MM-DD');
        break;
      case 'year':
        startDate = now.startOf('year').format('YYYY-MM-DD');
        endDate = now.endOf('year').format('YYYY-MM-DD');
        break;
      default:
        startDate = now.startOf('month').format('YYYY-MM-DD');
        endDate = now.endOf('month').format('YYYY-MM-DD');
    }

    const where = {
      clock_in_time: {
        [Sequelize.Op.between]: [startDate, endDate]
      }
    };

    if (store_id) where.store_id = store_id;

    // Get all staff
    const allStaff = await req.db.models.Staff.findAll({
      where: store_id ? { store_id, status: 'active' } : { status: 'active' },
      attributes: ['id', 'name', 'employee_id']
    });

    // Get attendance records
    const attendanceRecords = await req.db.models.StaffAttendance.findAll({
      where,
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id']
        }
      ]
    });

    // Calculate summary
    const totalDays = moment(endDate).diff(moment(startDate), 'days') + 1;
    const totalStaff = allStaff.length;
    const totalAttendanceRecords = attendanceRecords.length;
    
    const totalHours = attendanceRecords.reduce((sum, record) => {
      return sum + (parseFloat(record.work_duration) || 0);
    }, 0);

    const averageHoursPerStaff = totalStaff > 0 ? (totalHours / totalStaff).toFixed(2) : 0;
    const averageDaysWorked = totalStaff > 0 ? (totalAttendanceRecords / totalStaff).toFixed(2) : 0;
    const attendanceRate = totalStaff > 0 ? ((totalAttendanceRecords / (totalStaff * totalDays)) * 100).toFixed(2) : 0;

    // Count statuses
    const statusCounts = {
      present: attendanceRecords.filter(r => r.status === 'present').length,
      late: attendanceRecords.filter(r => r.status === 'late').length,
      early_leave: attendanceRecords.filter(r => r.status === 'early_leave').length,
      absent: attendanceRecords.filter(r => r.status === 'absent').length
    };

    res.json({
      success: true,
      data: {
        period: { start_date: startDate, end_date: endDate, period_type: period },
        summary: {
          total_staff: totalStaff,
          total_attendance_records: totalAttendanceRecords,
          total_hours_worked: parseFloat(totalHours.toFixed(2)),
          average_hours_per_staff: parseFloat(averageHoursPerStaff),
          average_days_worked: parseFloat(averageDaysWorked),
          attendance_rate_percentage: parseFloat(attendanceRate),
          total_days_in_period: totalDays
        },
        status_breakdown: statusCounts
      }
    });
  } catch (error) {
    console.error('Error getting attendance summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get attendance summary'
    });
  }
}

/**
 * Get top performers (by hours worked or attendance)
 */
async function getTopPerformers(req, res) {
  try {
    const { start_date, end_date, store_id, metric = 'hours', limit = 10 } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    const where = {
      clock_in_time: {
        [Sequelize.Op.between]: [start_date, end_date]
      }
    };

    if (store_id) where.store_id = store_id;

    let orderBy, attributes;

    if (metric === 'hours') {
      attributes = [
        'staff_id',
        [Sequelize.fn('SUM', Sequelize.col('work_duration')), 'total_hours'],
        [Sequelize.fn('COUNT', Sequelize.col('staff_attendance.id')), 'days_worked']
      ];
      orderBy = [[Sequelize.fn('SUM', Sequelize.col('work_duration')), 'DESC']];
    } else if (metric === 'attendance') {
      attributes = [
        'staff_id',
        [Sequelize.fn('COUNT', Sequelize.col('staff_attendance.id')), 'days_worked'],
        [Sequelize.fn('SUM', Sequelize.col('work_duration')), 'total_hours']
      ];
      orderBy = [[Sequelize.fn('COUNT', Sequelize.col('staff_attendance.id')), 'DESC']];
    } else {
      attributes = [
        'staff_id',
        [Sequelize.fn('SUM', Sequelize.col('work_duration')), 'total_hours'],
        [Sequelize.fn('COUNT', Sequelize.col('staff_attendance.id')), 'days_worked']
      ];
      orderBy = [[Sequelize.fn('SUM', Sequelize.col('work_duration')), 'DESC']];
    }

    const topPerformers = await req.db.models.StaffAttendance.findAll({
      where,
      attributes,
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id', 'email']
        }
      ],
      group: ['staff_id'],
      order: orderBy,
      limit: parseInt(limit),
      raw: false
    });

    const formatted = topPerformers.map(record => ({
      staff: {
        id: record.Staff.id,
        name: record.Staff.name,
        employee_id: record.Staff.employee_id,
        email: record.Staff.email
      },
      total_hours: parseFloat(record.dataValues.total_hours || 0).toFixed(2),
      days_worked: parseInt(record.dataValues.days_worked || 0),
      average_hours_per_day: record.dataValues.days_worked > 0 
        ? (parseFloat(record.dataValues.total_hours || 0) / parseInt(record.dataValues.days_worked || 1)).toFixed(2)
        : 0
    }));

    res.json({
      success: true,
      data: {
        period: { start_date, end_date },
        metric,
        top_performers: formatted
      }
    });
  } catch (error) {
    console.error('Error getting top performers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get top performers'
    });
  }
}

/**
 * Get attendance trends over time
 */
async function getAttendanceTrends(req, res) {
  try {
    const { start_date, end_date, store_id, group_by = 'day' } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    const where = {
      clock_in_time: {
        [Sequelize.Op.between]: [start_date, end_date]
      }
    };

    if (store_id) where.store_id = store_id;

    let dateFormat, groupByClause;

    switch (group_by) {
      case 'day':
        dateFormat = '%Y-%m-%d';
        groupByClause = Sequelize.fn('DATE', Sequelize.col('clock_in_time'));
        break;
      case 'week':
        dateFormat = '%Y-%u';
        groupByClause = Sequelize.fn('YEARWEEK', Sequelize.col('clock_in_time'));
        break;
      case 'month':
        dateFormat = '%Y-%m';
        groupByClause = Sequelize.fn('DATE_FORMAT', Sequelize.col('clock_in_time'), '%Y-%m');
        break;
      default:
        dateFormat = '%Y-%m-%d';
        groupByClause = Sequelize.fn('DATE', Sequelize.col('clock_in_time'));
    }

    const trends = await req.db.models.StaffAttendance.findAll({
      where,
      attributes: [
        [groupByClause, 'period'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'attendance_count'],
        [Sequelize.fn('COUNT', Sequelize.fn('DISTINCT', Sequelize.col('staff_id'))), 'unique_staff'],
        [Sequelize.fn('SUM', Sequelize.col('work_duration')), 'total_hours'],
        [Sequelize.fn('AVG', Sequelize.col('work_duration')), 'avg_hours_per_day']
      ],
      group: [groupByClause],
      order: [[groupByClause, 'ASC']],
      raw: true
    });

    res.json({
      success: true,
      data: {
        period: { start_date, end_date },
        group_by,
        trends: trends.map(t => ({
          period: t.period,
          attendance_count: parseInt(t.attendance_count),
          unique_staff: parseInt(t.unique_staff),
          total_hours: parseFloat(t.total_hours || 0).toFixed(2),
          average_hours_per_day: parseFloat(t.avg_hours_per_day || 0).toFixed(2)
        }))
      }
    });
  } catch (error) {
    console.error('Error getting attendance trends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get attendance trends'
    });
  }
}

/**
 * Helper function to calculate staff metrics
 */
function calculateStaffMetrics(attendanceRecords, startDate, endDate, groupBy) {
  const staffMap = new Map();
  const totalDays = moment(endDate).diff(moment(startDate), 'days') + 1;

  // Group by staff
  attendanceRecords.forEach(record => {
    const staffId = record.staff_id;
    if (!staffMap.has(staffId)) {
      staffMap.set(staffId, {
        staff: record.Staff,
        records: [],
        totalHours: 0,
        daysWorked: 0,
        lateCount: 0,
        earlyLeaveCount: 0,
        presentCount: 0
      });
    }

    const staffData = staffMap.get(staffId);
    staffData.records.push(record);
    staffData.totalHours += parseFloat(record.work_duration || 0);
    staffData.daysWorked += 1;
    
    if (record.status === 'late') staffData.lateCount += 1;
    if (record.status === 'early_leave') staffData.earlyLeaveCount += 1;
    if (record.status === 'present') staffData.presentCount += 1;
  });

  // Calculate summary
  const totalStaff = staffMap.size;
  const totalHours = Array.from(staffMap.values()).reduce((sum, data) => sum + data.totalHours, 0);
  const totalDaysWorked = Array.from(staffMap.values()).reduce((sum, data) => sum + data.daysWorked, 0);
  const totalLate = Array.from(staffMap.values()).reduce((sum, data) => sum + data.lateCount, 0);

  // Build staff breakdown
  const staffBreakdown = Array.from(staffMap.entries()).map(([staffId, data]) => {
    const averageHoursPerDay = data.daysWorked > 0 ? (data.totalHours / data.daysWorked).toFixed(2) : 0;
    const attendanceRate = ((data.daysWorked / totalDays) * 100).toFixed(2);
    const punctualityScore = data.daysWorked > 0 
      ? (((data.presentCount / data.daysWorked) * 100).toFixed(2))
      : 0;

    return {
      staff: {
        id: data.staff.id,
        name: data.staff.name,
        employee_id: data.staff.employee_id,
        email: data.staff.email
      },
      metrics: {
        total_hours: parseFloat(data.totalHours.toFixed(2)),
        days_worked: data.daysWorked,
        average_hours_per_day: parseFloat(averageHoursPerDay),
        attendance_rate_percentage: parseFloat(attendanceRate),
        punctuality_score: parseFloat(punctualityScore),
        late_arrivals: data.lateCount,
        early_departures: data.earlyLeaveCount,
        present_days: data.presentCount
      }
    };
  });

  // Calculate trends (group by period)
  const trends = calculateTrends(attendanceRecords, startDate, endDate, groupBy);

  return {
    summary: {
      total_staff: totalStaff,
      total_hours_worked: parseFloat(totalHours.toFixed(2)),
      total_days_worked: totalDaysWorked,
      average_hours_per_staff: totalStaff > 0 ? parseFloat((totalHours / totalStaff).toFixed(2)) : 0,
      average_days_per_staff: totalStaff > 0 ? parseFloat((totalDaysWorked / totalStaff).toFixed(2)) : 0,
      total_late_arrivals: totalLate,
      period_days: totalDays
    },
    staffBreakdown,
    trends,
    comparisons: {
      best_attendance: staffBreakdown.sort((a, b) => b.metrics.days_worked - a.metrics.days_worked)[0] || null,
      most_hours: staffBreakdown.sort((a, b) => b.metrics.total_hours - a.metrics.total_hours)[0] || null,
      most_punctual: staffBreakdown.sort((a, b) => b.metrics.punctuality_score - a.metrics.punctuality_score)[0] || null
    }
  };
}

/**
 * Helper function to calculate individual staff metrics
 */
function calculateIndividualStaffMetrics(attendanceRecords, startDate, endDate) {
  const totalDays = moment(endDate).diff(moment(startDate), 'days') + 1;
  const totalHours = attendanceRecords.reduce((sum, r) => sum + parseFloat(r.work_duration || 0), 0);
  const daysWorked = attendanceRecords.length;
  const lateCount = attendanceRecords.filter(r => r.status === 'late').length;
  const earlyLeaveCount = attendanceRecords.filter(r => r.status === 'early_leave').length;
  const presentCount = attendanceRecords.filter(r => r.status === 'present').length;

  const averageHoursPerDay = daysWorked > 0 ? (totalHours / daysWorked).toFixed(2) : 0;
  const attendanceRate = ((daysWorked / totalDays) * 100).toFixed(2);
  const punctualityScore = daysWorked > 0 ? (((presentCount / daysWorked) * 100).toFixed(2)) : 0;

  // Weekly breakdown
  const weeklyBreakdown = {};
  attendanceRecords.forEach(record => {
    const week = moment(record.clock_in_time).format('YYYY-[W]WW');
    if (!weeklyBreakdown[week]) {
      weeklyBreakdown[week] = {
        week,
        days_worked: 0,
        total_hours: 0,
        late_count: 0
      };
    }
    weeklyBreakdown[week].days_worked += 1;
    weeklyBreakdown[week].total_hours += parseFloat(record.work_duration || 0);
    if (record.status === 'late') weeklyBreakdown[week].late_count += 1;
  });

  return {
    overview: {
      total_hours_worked: parseFloat(totalHours.toFixed(2)),
      days_worked: daysWorked,
      total_days_in_period: totalDays,
      average_hours_per_day: parseFloat(averageHoursPerDay),
      attendance_rate_percentage: parseFloat(attendanceRate),
      punctuality_score: parseFloat(punctualityScore)
    },
    status_breakdown: {
      present: presentCount,
      late: lateCount,
      early_leave: earlyLeaveCount,
      absent: totalDays - daysWorked
    },
    weekly_breakdown: Object.values(weeklyBreakdown).map(week => ({
      ...week,
      total_hours: parseFloat(week.total_hours.toFixed(2)),
      average_hours_per_day: week.days_worked > 0 
        ? parseFloat((week.total_hours / week.days_worked).toFixed(2))
        : 0
    }))
  };
}

/**
 * Helper function to calculate trends
 */
function calculateTrends(attendanceRecords, startDate, endDate, groupBy) {
  const trendsMap = new Map();

  attendanceRecords.forEach(record => {
    let period;
    if (groupBy === 'day') {
      period = moment(record.clock_in_time).format('YYYY-MM-DD');
    } else if (groupBy === 'week') {
      period = moment(record.clock_in_time).format('YYYY-[W]WW');
    } else if (groupBy === 'month') {
      period = moment(record.clock_in_time).format('YYYY-MM');
    } else {
      period = moment(record.clock_in_time).format('YYYY-MM-DD');
    }

    if (!trendsMap.has(period)) {
      trendsMap.set(period, {
        period,
        attendance_count: 0,
        total_hours: 0,
        unique_staff: new Set()
      });
    }

    const trend = trendsMap.get(period);
    trend.attendance_count += 1;
    trend.total_hours += parseFloat(record.work_duration || 0);
    trend.unique_staff.add(record.staff_id);
  });

  return Array.from(trendsMap.values()).map(trend => ({
    period: trend.period,
    attendance_count: trend.attendance_count,
    unique_staff_count: trend.unique_staff.size,
    total_hours: parseFloat(trend.total_hours.toFixed(2)),
    average_hours: trend.attendance_count > 0 
      ? parseFloat((trend.total_hours / trend.attendance_count).toFixed(2))
      : 0
  })).sort((a, b) => a.period.localeCompare(b.period));
}

module.exports = {
  getStaffAnalytics,
  getStaffMemberAnalytics,
  getAttendanceSummary,
  getTopPerformers,
  getAttendanceTrends
};

